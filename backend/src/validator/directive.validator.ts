import { Injectable, Logger } from '@nestjs/common';
import type { RawInterpretation } from '../llm/llm.service.js';
import {
  isDirectiveType,
  noOpInterpretation,
  type DirectiveInterpretation,
  type DirectiveType,
  type StructuredAdjustment,
  type ValidatedDirective,
} from '../schemas/directive.schema.js';
import { toFiniteNumber, toFraction, validateHours } from './hours.util.js';

export interface ValidationContext {
  /** Hour indexes actually present in the scenario. */
  horizonHours: number[];
  /** Used to convert a percentage reserve into kWh and to clamp the floor. */
  batteryCapacityKwh: number;
}

export interface ValidationIssue {
  note_index: number;
  severity: 'warning' | 'rejected' | 'missing';
  reason: string;
}

export interface ValidationOutcome {
  /** Exactly one entry per operator note, in ascending note_index order. */
  interpretations: DirectiveInterpretation[];
  /** Actionable directives only — `no_op` never reaches the optimizer. */
  directives: ValidatedDirective[];
  issues: ValidationIssue[];
  /** Notes the model did not answer at all — candidates for a repair call. */
  missingNoteIndexes: number[];
  /** Notes whose directive failed validation — candidates for a repair call. */
  rejectedNoteIndexes: number[];
}

interface AdjustmentOutcome {
  adjustment: StructuredAdjustment;
  warnings: string[];
  error?: string;
}

/**
 * The trust boundary between the language model and the optimizer.
 *
 * Nothing the model produces is taken at face value: unknown directive types,
 * malformed hours and non-numeric values are rejected and downgraded to
 * `no_op`, so a hallucinating model can degrade the plan but never corrupt it.
 */
@Injectable()
export class DirectiveValidatorService {
  private readonly logger = new Logger(DirectiveValidatorService.name);

  validate(
    raw: RawInterpretation[],
    notes: string[],
    context: ValidationContext,
  ): ValidationOutcome {
    const byIndex = this.indexByNote(raw, notes.length);
    const interpretations: DirectiveInterpretation[] = [];
    const directives: ValidatedDirective[] = [];
    const issues: ValidationIssue[] = [];
    const missingNoteIndexes: number[] = [];
    const rejectedNoteIndexes: number[] = [];

    for (const [noteIndex, note] of notes.entries()) {
      const candidate = byIndex.get(noteIndex);

      if (!candidate) {
        missingNoteIndexes.push(noteIndex);
        issues.push({
          note_index: noteIndex,
          severity: 'missing',
          reason: 'the interpreter returned no object for this note',
        });
        interpretations.push(
          noOpInterpretation(
            noteIndex,
            'No directive could be interpreted for this note; it was left unapplied.',
          ),
        );
        continue;
      }

      const result = this.validateOne(candidate, noteIndex, note, context);
      interpretations.push(result.interpretation);
      issues.push(...result.issues);

      if (result.directive) directives.push(result.directive);
      if (result.rejected) rejectedNoteIndexes.push(noteIndex);
    }

    if (issues.length) {
      this.logger.warn(
        `Directive validation issues: ${issues
          .map(
            (issue) =>
              `#${issue.note_index} ${issue.severity}: ${issue.reason}`,
          )
          .join(' | ')}`,
      );
    }

    return {
      interpretations,
      directives,
      issues,
      missingNoteIndexes,
      rejectedNoteIndexes,
    };
  }

  /** First object wins per note index; extras are ignored (notes are never merged). */
  private indexByNote(
    raw: RawInterpretation[],
    noteCount: number,
  ): Map<number, RawInterpretation> {
    const byIndex = new Map<number, RawInterpretation>();

    for (const item of raw) {
      const index = toFiniteNumber(item?.note_index);
      if (index === null || !Number.isInteger(index)) continue;
      if (index < 0 || index >= noteCount) continue;
      if (!byIndex.has(index)) byIndex.set(index, item);
    }

    // Positional rescue: a model that dropped note_index entirely but returned
    // the right number of objects in order is still usable.
    if (byIndex.size === 0 && raw.length === noteCount) {
      raw.forEach((item, index) => byIndex.set(index, item));
    }

    return byIndex;
  }

  private validateOne(
    candidate: RawInterpretation,
    noteIndex: number,
    note: string,
    context: ValidationContext,
  ): {
    interpretation: DirectiveInterpretation;
    directive?: ValidatedDirective;
    issues: ValidationIssue[];
    rejected: boolean;
  } {
    const issues: ValidationIssue[] = [];
    const explanation = this.cleanExplanation(candidate.explanation, note);

    const rawType =
      typeof candidate.directive_type === 'string'
        ? candidate.directive_type.trim().toLowerCase()
        : '';

    if (!isDirectiveType(rawType)) {
      issues.push({
        note_index: noteIndex,
        severity: 'rejected',
        reason: `unsupported directive_type ${JSON.stringify(candidate.directive_type)}`,
      });
      return {
        interpretation: noOpInterpretation(
          noteIndex,
          `Unsupported directive was rejected; note left unapplied. ${explanation}`.trim(),
        ),
        issues,
        rejected: true,
      };
    }

    const type: DirectiveType = rawType;
    const applies = candidate.applies !== false && type !== 'no_op';

    if (type === 'no_op' || !applies) {
      return {
        interpretation: {
          note_index: noteIndex,
          applies: false,
          directive_type: 'no_op',
          structured_adjustment: {},
          explanation,
        },
        issues,
        rejected: false,
      };
    }

    const adjustmentSource = this.asRecord(candidate.structured_adjustment);
    const outcome = this.validateAdjustment(type, adjustmentSource, context);

    for (const warning of outcome.warnings) {
      issues.push({
        note_index: noteIndex,
        severity: 'warning',
        reason: warning,
      });
    }

    if (outcome.error) {
      issues.push({
        note_index: noteIndex,
        severity: 'rejected',
        reason: `${type}: ${outcome.error}`,
      });
      return {
        interpretation: noOpInterpretation(
          noteIndex,
          `Directive rejected by validation (${outcome.error}); note left unapplied.`,
        ),
        issues,
        rejected: true,
      };
    }

    return {
      interpretation: {
        note_index: noteIndex,
        applies: true,
        directive_type: type,
        structured_adjustment: outcome.adjustment,
        explanation,
      },
      directive: {
        note_index: noteIndex,
        directive_type: type as Exclude<DirectiveType, 'no_op'>,
        structured_adjustment: outcome.adjustment,
      },
      issues,
      rejected: false,
    };
  }

  private validateAdjustment(
    type: Exclude<DirectiveType, 'no_op'>,
    source: Record<string, unknown>,
    context: ValidationContext,
  ): AdjustmentOutcome {
    switch (type) {
      case 'solar_reduction':
        return this.validateSolarReduction(source, context);
      case 'minimum_battery_reserve':
        return this.validateMinimumReserve(source, context);
      case 'no_charge_window':
      case 'no_discharge_window':
        return this.validateHourWindow(source, context);
      case 'max_grid_window':
        return this.validateMaxGridWindow(source, context);
      default:
        return {
          adjustment: {},
          warnings: [],
          error: 'unhandled directive type',
        };
    }
  }

  private validateSolarReduction(
    source: Record<string, unknown>,
    context: ValidationContext,
  ): AdjustmentOutcome {
    const hours = validateHours(source.hours, context.horizonHours);
    if (hours.error) {
      return { adjustment: {}, warnings: hours.warnings, error: hours.error };
    }

    const factor = toFraction(
      source.factor ?? source.reduction ?? source.reduction_factor,
    );
    if (factor === null) {
      return {
        adjustment: {},
        warnings: hours.warnings,
        error: `"factor" must be a number in 0-1 (received ${JSON.stringify(source.factor)})`,
      };
    }

    return {
      adjustment: { hours: hours.hours, factor },
      warnings: hours.warnings,
    };
  }

  private validateMinimumReserve(
    source: Record<string, unknown>,
    context: ValidationContext,
  ): AdjustmentOutcome {
    const warnings: string[] = [];
    let reserve = toFiniteNumber(
      source.reserve_kwh ?? source.min_reserve_kwh ?? source.reserve,
    );

    if (reserve === null) {
      const percent = toFiniteNumber(
        source.reserve_percent ?? source.percent ?? source.soc_percent,
      );
      if (percent === null) {
        return {
          adjustment: {},
          warnings,
          error: '"reserve_kwh" (or "reserve_percent") must be a number',
        };
      }
      if (percent < 0 || percent > 100) {
        return {
          adjustment: {},
          warnings,
          error: `"reserve_percent" must be within 0-100 (received ${percent})`,
        };
      }
      reserve = (percent / 100) * context.batteryCapacityKwh;
      warnings.push(
        `reserve_percent ${percent} converted to ${round(reserve)} kWh using battery capacity`,
      );
    }

    if (reserve < 0) {
      return {
        adjustment: {},
        warnings,
        error: `"reserve_kwh" must not be negative (received ${reserve})`,
      };
    }

    if (reserve > context.batteryCapacityKwh) {
      warnings.push(
        `reserve ${round(reserve)} kWh exceeded battery capacity and was clamped to ${round(context.batteryCapacityKwh)} kWh`,
      );
      reserve = context.batteryCapacityKwh;
    }

    const adjustment: StructuredAdjustment = { reserve_kwh: round(reserve) };

    if (source.hours !== undefined && source.hours !== null) {
      const hours = validateHours(source.hours, context.horizonHours);
      if (hours.error) {
        warnings.push(
          `optional "hours" ignored for minimum_battery_reserve (${hours.error})`,
        );
      } else {
        warnings.push(...hours.warnings);
        (adjustment as { hours?: number[] }).hours = hours.hours;
      }
    }

    return { adjustment, warnings };
  }

  private validateHourWindow(
    source: Record<string, unknown>,
    context: ValidationContext,
  ): AdjustmentOutcome {
    const hours = validateHours(source.hours, context.horizonHours);
    if (hours.error) {
      return { adjustment: {}, warnings: hours.warnings, error: hours.error };
    }
    return { adjustment: { hours: hours.hours }, warnings: hours.warnings };
  }

  private validateMaxGridWindow(
    source: Record<string, unknown>,
    context: ValidationContext,
  ): AdjustmentOutcome {
    const hours = validateHours(source.hours, context.horizonHours);
    if (hours.error) {
      return { adjustment: {}, warnings: hours.warnings, error: hours.error };
    }

    const maxKwh = toFiniteNumber(
      source.max_kwh ??
        source.max_grid_kwh ??
        source.limit_kwh ??
        source.cap_kwh,
    );
    if (maxKwh === null || maxKwh < 0) {
      return {
        adjustment: {},
        warnings: hours.warnings,
        error: `"max_kwh" must be a non-negative number (received ${JSON.stringify(source.max_kwh)})`,
      };
    }

    return {
      adjustment: { hours: hours.hours, max_kwh: maxKwh },
      warnings: hours.warnings,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private cleanExplanation(value: unknown, note: string): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) return text.slice(0, 500);
    return `No explanation was returned for note: ${note.slice(0, 120)}`;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
