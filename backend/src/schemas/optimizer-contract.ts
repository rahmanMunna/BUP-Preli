import type { ValidatedDirective } from './directive.schema.js';
import type { HourlyPlanEntry } from './optimize-response.dto.js';

/** Normalised hour record handed to the optimizer. */
export interface OptimizerHour {
  hour: number;
  demand_kwh: number;
  solar_kwh: number;
  tariff_bdt_per_kwh: number;
}

/** Normalised battery record handed to the optimizer. */
export interface OptimizerBattery {
  capacity_kwh: number;
  initial_soc_kwh: number;
  max_charge_kwh: number;
  max_discharge_kwh: number;
  efficiency: number;
  min_reserve_kwh: number;
}

/** Request body of `POST {OPTIMIZER_URL}/optimize`. */
export interface OptimizerRequest {
  scenario_id: string;
  hours: OptimizerHour[];
  battery: OptimizerBattery;
  directives: ValidatedDirective[];
}

/** Response body expected back from the Python optimizer service. */
export interface OptimizerResult {
  hourly_plan: HourlyPlanEntry[];
  total_grid_kwh?: number;
  total_cost_bdt?: number;
  peak_grid_kwh?: number;
  plan_summary?: string;
  /** Set by this API, not by the Python service. */
  engine?: 'python-optimizer' | 'local-fallback';
}
