import type { DirectiveInterpretation } from './directive.schema.js';

/** One row of the dispatch schedule, one per hour supplied in the request. */
export interface HourlyPlanEntry {
  hour: number;
  demand_kwh: number;
  /** Solar available after any `solar_reduction` directive was applied. */
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

/** Exact response body contract of `POST /optimize-energy`. */
export interface OptimizeEnergyResponse {
  scenario_id: string;
  directive_interpretation: DirectiveInterpretation[];
  hourly_plan: HourlyPlanEntry[];
  total_grid_kwh: number;
  total_cost_bdt: number;
  peak_grid_kwh: number;
  plan_summary: string;
}
