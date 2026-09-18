/** Derivations the dashboard needs from a returned schedule. */

import type { BatteryInput, HourInput, HourlyPlanEntry } from "./types";

export interface BatterySummary {
  startSoc: number;
  endSoc: number;
  minSoc: number;
  maxSoc: number;
  charged: number;
  discharged: number;
  /** End-of-horizon charge as a share of capacity, for the status card. */
  endFraction: number;
  /** Whether the pack ends the day where it started, within rounding. */
  isNeutral: boolean;
}

export function summarizeBattery(
  plan: HourlyPlanEntry[],
  battery: BatteryInput,
): BatterySummary | null {
  if (plan.length === 0) return null;

  const socs = plan.map((row) => row.battery_soc_kwh);
  const endSoc = socs[socs.length - 1];

  return {
    startSoc: battery.initial_soc_kwh,
    endSoc,
    minSoc: Math.min(...socs),
    maxSoc: Math.max(...socs),
    charged: sum(plan.map((row) => row.battery_charge_kwh)),
    discharged: sum(plan.map((row) => row.battery_discharge_kwh)),
    endFraction:
      battery.capacity_kwh > 0 ? endSoc / battery.capacity_kwh : 0,
    isNeutral: Math.abs(endSoc - battery.initial_soc_kwh) < 0.5,
  };
}

/**
 * What the day would have cost buying every kWh from the grid as it came,
 * with no battery. The plan is only interesting relative to that.
 */
export function baselineCost(hours: HourInput[]): number {
  return sum(
    hours.map(
      (hour) =>
        Math.max(0, hour.demand_kwh - hour.solar_kwh) * hour.tariff_bdt_per_kwh,
    ),
  );
}

export function baselinePeak(hours: HourInput[]): number {
  return hours.reduce(
    (peak, hour) => Math.max(peak, Math.max(0, hour.demand_kwh - hour.solar_kwh)),
    0,
  );
}

export function peakHour(plan: HourlyPlanEntry[]): HourlyPlanEntry | null {
  if (plan.length === 0) return null;
  return plan.reduce((best, row) => (row.grid_kwh > best.grid_kwh ? row : best));
}

/** Change relative to a baseline, as a signed fraction (-0.12 = 12% cheaper). */
export function delta(actual: number, baseline: number): number | null {
  if (!Number.isFinite(baseline) || baseline === 0) return null;
  return (actual - baseline) / baseline;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
