/**
 * Contracts shared with the NestJS API (`POST /optimize-energy`).
 *
 * Kept as hand-written mirrors rather than generated types: the API is a
 * separate service in this monorepo and the payload is small enough that an
 * explicit copy is easier to read than a build step.
 */

export const DIRECTIVE_TYPES = [
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
] as const;

export type DirectiveType = (typeof DIRECTIVE_TYPES)[number];

export interface HourInput {
  hour: number;
  demand_kwh: number;
  solar_kwh: number;
  tariff_bdt_per_kwh: number;
}

export interface BatteryInput {
  capacity_kwh: number;
  initial_soc_kwh: number;
  max_charge_kwh: number;
  max_discharge_kwh: number;
  efficiency: number;
  min_reserve_kwh: number;
}

export interface OptimizeRequest {
  scenario_id: string;
  operator_notes: string[];
  hours: HourInput[];
  battery: BatteryInput;
}

/** One interpreted operator note — exactly one per note, in note order. */
export interface DirectiveInterpretation {
  note_index: number;
  applies: boolean;
  directive_type: DirectiveType;
  structured_adjustment: StructuredAdjustment;
  explanation: string;
}

export interface StructuredAdjustment {
  hours?: number[];
  factor?: number;
  reserve_kwh?: number;
  max_kwh?: number;
  [key: string]: unknown;
}

export interface HourlyPlanEntry {
  hour: number;
  demand_kwh: number;
  /** Solar available after any `solar_reduction` directive. */
  solar_kwh: number;
  solar_used_kwh: number;
  battery_charge_kwh: number;
  battery_discharge_kwh: number;
  /** State of charge at the END of the hour. */
  battery_soc_kwh: number;
  grid_kwh: number;
  tariff_bdt_per_kwh: number;
  cost_bdt: number;
}

export interface OptimizeResponse {
  scenario_id: string;
  directive_interpretation: DirectiveInterpretation[];
  hourly_plan: HourlyPlanEntry[];
  total_grid_kwh: number;
  total_cost_bdt: number;
  peak_grid_kwh: number;
  plan_summary: string;
}

/** Error envelope returned by the NestJS global exception filter. */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path?: string;
  timestamp?: string;
}
