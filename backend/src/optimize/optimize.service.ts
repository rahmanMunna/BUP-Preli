import { Injectable, Logger } from '@nestjs/common';
import type { RawInterpretation } from '../llm/llm.service.js';
import { LlmService } from '../llm/llm.service.js';
import type { NoteForInterpretation } from '../llm/prompt.js';
import { OptimizerClient } from '../optimizer/optimizer.client.js';
import {
  noOpInterpretation,
  type DirectiveInterpretation,
} from '../schemas/directive.schema.js';
import type {
  BatteryInputDto,
  OptimizeEnergyRequestDto,
} from '../schemas/optimize-request.dto.js';
import type {
  HourlyPlanEntry,
  OptimizeEnergyResponse,
} from '../schemas/optimize-response.dto.js';
import type {
  OptimizerBattery,
  OptimizerHour,
  OptimizerResult,
} from '../schemas/optimizer-contract.js';
import type { ValidationOutcome } from '../validator/directive.validator.js';
import { DirectiveValidatorService } from '../validator/directive.validator.js';

const DEGRADED_EXPLANATION =
  'Directive interpretation was unavailable (all LLM providers failed); the note was not applied.';

@Injectable()
export class OptimizeService {
  private readonly logger = new Logger(OptimizeService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly validator: DirectiveValidatorService,
    private readonly optimizer: OptimizerClient,
  ) {}

  /**
   * Full request pipeline: notes -> LLM -> validation -> optimizer -> schedule.
   * Every stage degrades rather than throws, so a judge always receives a
   * complete, internally consistent response body.
   */
  async optimizeEnergy(
    request: OptimizeEnergyRequestDto,
  ): Promise<OptimizeEnergyResponse> {
    const startedAt = Date.now();
    const hours = this.normalizeHours(request);
    const battery = this.normalizeBattery(request.battery);
    const notes = request.operator_notes ?? [];
    const horizonHours = hours.map((hour) => hour.hour);

    this.logger.log(
      `scenario=${request.scenario_id} hours=${hours.length} notes=${notes.length}`,
    );

    const { interpretations, directives } = await this.interpretNotes(
      notes,
      horizonHours,
      battery.capacity_kwh,
    );

    const result = await this.optimizer.optimize({
      scenario_id: request.scenario_id,
      hours,
      battery,
      directives,
    });

    const response = this.buildResponse(
      request.scenario_id,
      interpretations,
      result,
    );

    this.logger.log(
      `scenario=${request.scenario_id} engine=${result.engine} directives=${directives.length}/${notes.length} ` +
        `grid=${response.total_grid_kwh}kWh cost=${response.total_cost_bdt}BDT in ${Date.now() - startedAt}ms`,
    );

    return response;
  }

  /** Interprets every note, with one targeted repair pass for bad answers. */
  private async interpretNotes(
    notes: string[],
    horizonHours: number[],
    batteryCapacityKwh: number,
  ): Promise<Pick<ValidationOutcome, 'interpretations' | 'directives'>> {
    if (notes.length === 0) return { interpretations: [], directives: [] };

    const context = { horizonHours, batteryCapacityKwh };
    const allNotes: NoteForInterpretation[] = notes.map((text, index) => ({
      index,
      text,
    }));

    const first = await this.llm.interpret(allNotes, horizonHours);

    if (first.degraded) {
      return {
        interpretations: notes.map((_, index) =>
          noOpInterpretation(index, DEGRADED_EXPLANATION),
        ),
        directives: [],
      };
    }

    const rawByIndex = new Map<number, RawInterpretation>();
    this.indexRaw(first.interpretations, rawByIndex, notes.length);

    let outcome = this.validator.validate(
      [...rawByIndex.values()],
      notes,
      context,
    );

    const needsRepair = [
      ...new Set([
        ...outcome.missingNoteIndexes,
        ...outcome.rejectedNoteIndexes,
      ]),
    ].sort((a, b) => a - b);

    if (needsRepair.length > 0) {
      this.logger.warn(
        `Re-asking the interpreter for note(s) ${needsRepair.join(', ')}`,
      );

      const problems = outcome.issues
        .filter(
          (issue) =>
            issue.severity !== 'warning' &&
            needsRepair.includes(issue.note_index),
        )
        .map((issue) => `note_index ${issue.note_index}: ${issue.reason}`);

      const repair = await this.llm.interpret(
        needsRepair.map((index) => ({ index, text: notes[index] })),
        horizonHours,
        problems,
      );

      if (!repair.degraded && repair.interpretations.length > 0) {
        this.indexRaw(
          repair.interpretations,
          rawByIndex,
          notes.length,
          needsRepair,
        );
        outcome = this.validator.validate(
          [...rawByIndex.values()].sort(
            (a, b) => Number(a.note_index) - Number(b.note_index),
          ),
          notes,
          context,
        );
      }
    }

    return {
      interpretations: outcome.interpretations,
      directives: outcome.directives,
    };
  }

  /**
   * Stores raw model objects by note index. `allowedIndexes` restricts a repair
   * pass to the notes it was asked about, so it can never overwrite a note that
   * was already interpreted correctly.
   */
  private indexRaw(
    items: RawInterpretation[],
    target: Map<number, RawInterpretation>,
    noteCount: number,
    allowedIndexes?: number[],
  ): void {
    items.forEach((item, position) => {
      const parsed = Number(item?.note_index);
      let index = Number.isInteger(parsed) ? parsed : Number.NaN;

      // A repair call that answered in order but forgot note_index.
      if (
        !Number.isInteger(index) &&
        allowedIndexes?.[position] !== undefined
      ) {
        index = allowedIndexes[position];
      }
      if (!Number.isInteger(index) || index < 0 || index >= noteCount) return;
      if (allowedIndexes && !allowedIndexes.includes(index)) return;

      target.set(index, { ...item, note_index: index });
    });
  }

  private normalizeHours(request: OptimizeEnergyRequestDto): OptimizerHour[] {
    return [...request.hours]
      .map((hour) => ({
        hour: hour.hour,
        demand_kwh: hour.demand_kwh,
        solar_kwh: hour.solar_kwh ?? 0,
        tariff_bdt_per_kwh: hour.tariff_bdt_per_kwh,
      }))
      .sort((a, b) => a.hour - b.hour);
  }

  private normalizeBattery(battery: BatteryInputDto): OptimizerBattery {
    const capacity = battery.capacity_kwh;
    return {
      capacity_kwh: capacity,
      initial_soc_kwh: Math.min(battery.initial_soc_kwh ?? 0, capacity),
      // Absent rate limits mean "no intra-hour limit beyond the pack size".
      max_charge_kwh: battery.max_charge_kwh ?? capacity,
      max_discharge_kwh: battery.max_discharge_kwh ?? capacity,
      efficiency: battery.efficiency ?? 0.95,
      min_reserve_kwh: Math.min(battery.min_reserve_kwh ?? 0, capacity),
    };
  }

  /**
   * Totals are always recomputed from `hourly_plan`, so the summary numbers can
   * never disagree with the schedule the judge is reading.
   */
  private buildResponse(
    scenarioId: string,
    interpretations: DirectiveInterpretation[],
    result: OptimizerResult,
  ): OptimizeEnergyResponse {
    const plan = result.hourly_plan;
    const totalGrid = round(sum(plan.map((row) => row.grid_kwh)));
    const totalCost = round(
      sum(
        plan.map(
          (row) => row.cost_bdt ?? row.grid_kwh * row.tariff_bdt_per_kwh,
        ),
      ),
    );
    const peakGrid = round(
      plan.reduce((peak, row) => Math.max(peak, row.grid_kwh), 0),
    );

    this.warnOnTotalsMismatch(result, totalGrid, totalCost, peakGrid);

    return {
      scenario_id: scenarioId,
      directive_interpretation: interpretations,
      hourly_plan: plan,
      total_grid_kwh: totalGrid,
      total_cost_bdt: totalCost,
      peak_grid_kwh: peakGrid,
      plan_summary:
        result.plan_summary?.trim() ||
        this.summarize(
          interpretations,
          plan,
          totalGrid,
          totalCost,
          peakGrid,
          result,
        ),
    };
  }

  private warnOnTotalsMismatch(
    result: OptimizerResult,
    totalGrid: number,
    totalCost: number,
    peakGrid: number,
  ): void {
    const checks: Array<[string, number | undefined, number]> = [
      ['total_grid_kwh', result.total_grid_kwh, totalGrid],
      ['total_cost_bdt', result.total_cost_bdt, totalCost],
      ['peak_grid_kwh', result.peak_grid_kwh, peakGrid],
    ];

    for (const [field, reported, computed] of checks) {
      if (reported === undefined) continue;
      if (Math.abs(reported - computed) > Math.max(0.01, computed * 0.005)) {
        this.logger.warn(
          `Optimizer ${field}=${reported} disagrees with the schedule (${computed}); using the computed value`,
        );
      }
    }
  }

  private summarize(
    interpretations: DirectiveInterpretation[],
    plan: HourlyPlanEntry[],
    totalGrid: number,
    totalCost: number,
    peakGrid: number,
    result: OptimizerResult,
  ): string {
    const applied = interpretations.filter((item) => item.applies).length;
    const peakHour = plan.reduce(
      (best, row) => (row.grid_kwh > best.grid_kwh ? row : best),
      plan[0] ?? { hour: 0, grid_kwh: 0 },
    );
    const solarUsed = round(sum(plan.map((row) => row.solar_used_kwh)));
    const discharged = round(sum(plan.map((row) => row.battery_discharge_kwh)));
    const charged = round(sum(plan.map((row) => row.battery_charge_kwh)));
    const engine =
      result.engine === 'local-fallback'
        ? 'local fallback dispatcher (optimizer service unreachable)'
        : 'optimizer service';

    return (
      `Applied ${applied} of ${interpretations.length} operator note(s) as directives. ` +
      `The plan imports ${totalGrid} kWh from the grid for BDT ${totalCost}, peaking at ` +
      `${peakGrid} kWh in hour ${peakHour.hour}. Solar served ${solarUsed} kWh of demand and the ` +
      `battery absorbed ${charged} kWh while delivering ${discharged} kWh. Schedule produced by the ${engine}.`
    );
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
