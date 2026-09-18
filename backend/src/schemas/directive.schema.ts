/**
 * GridWise directive contract.
 *
 * These are the ONLY adjustments the LLM is allowed to produce. Anything the
 * interpreter returns outside this contract is rejected by the validator and
 * downgraded to `no_op`, so an unpredictable model can never corrupt the
 * optimization input.
 */

export const DIRECTIVE_TYPES = [
  'solar_reduction',
  'minimum_battery_reserve',
  'no_charge_window',
  'no_discharge_window',
  'max_grid_window',
  'no_op',
] as const;

export type DirectiveType = (typeof DIRECTIVE_TYPES)[number];

export function isDirectiveType(value: unknown): value is DirectiveType {
  return (
    typeof value === 'string' &&
    (DIRECTIVE_TYPES as readonly string[]).includes(value)
  );
}

/** Solar output of the listed hours is multiplied by `(1 - factor)`. */
export interface SolarReductionAdjustment {
  hours: number[];
  factor: number;
}

/** Battery state of charge may never fall below `reserve_kwh`. */
export interface MinimumBatteryReserveAdjustment {
  reserve_kwh: number;
  /** Optional: when omitted the reserve applies to the whole horizon. */
  hours?: number[];
}

/** Battery charging is forbidden during the listed hours. */
export interface NoChargeWindowAdjustment {
  hours: number[];
}

/** Battery discharging is forbidden during the listed hours. */
export interface NoDischargeWindowAdjustment {
  hours: number[];
}

/** Grid import in each of the listed hours is capped at `max_kwh`. */
export interface MaxGridWindowAdjustment {
  hours: number[];
  max_kwh: number;
}

/** The note carries no actionable instruction. */
export type NoOpAdjustment = Record<string, never>;

export type StructuredAdjustment =
  | SolarReductionAdjustment
  | MinimumBatteryReserveAdjustment
  | NoChargeWindowAdjustment
  | NoDischargeWindowAdjustment
  | MaxGridWindowAdjustment
  | NoOpAdjustment;

/** One interpretation object per operator note — never merged, never skipped. */
export interface DirectiveInterpretation {
  note_index: number;
  applies: boolean;
  directive_type: DirectiveType;
  structured_adjustment: StructuredAdjustment;
  explanation: string;
}

/** Directive shipped to the optimizer once validation has passed. */
export interface ValidatedDirective {
  note_index: number;
  directive_type: Exclude<DirectiveType, 'no_op'>;
  structured_adjustment: StructuredAdjustment;
}

export function noOpInterpretation(
  noteIndex: number,
  explanation: string,
): DirectiveInterpretation {
  return {
    note_index: noteIndex,
    applies: false,
    directive_type: 'no_op',
    structured_adjustment: {},
    explanation,
  };
}
