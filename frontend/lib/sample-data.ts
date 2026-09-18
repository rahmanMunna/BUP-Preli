/**
 * A realistic BUP campus day, used as the starting scenario so the dashboard
 * is usable the moment it loads. Demand peaks in the evening, solar peaks at
 * midday, and the tariff has the three bands a Bangladeshi campus typically
 * sees (off-peak night, flat day, evening peak).
 */

import type { BatteryInput, HourInput } from "./types";

const DEMAND_BY_HOUR = [
  18, 16, 15, 15, 16, 20, 26, 32, 38, 44, 48, 52, 55, 57, 54, 50, 52, 58, 66,
  71, 64, 49, 37, 24,
];

const SOLAR_BY_HOUR = [
  0, 0, 0, 0, 0, 0, 2, 10, 22, 34, 41, 46, 45, 40, 31, 18, 6, 1, 0, 0, 0, 0, 0,
  0,
];

/** Off-peak 23:00-05:00, flat through the day, peak 18:00-20:00. */
function tariffFor(hour: number): number {
  if (hour >= 18 && hour <= 20) return 14.2;
  if (hour >= 15 && hour <= 17) return 8.9;
  if (hour === 21) return 8.9;
  if (hour >= 23 || hour <= 5) return 4.8;
  return 6.2;
}

export const SAMPLE_HOURS: HourInput[] = Array.from(
  { length: 24 },
  (_, hour) => ({
    hour,
    demand_kwh: DEMAND_BY_HOUR[hour],
    solar_kwh: SOLAR_BY_HOUR[hour],
    tariff_bdt_per_kwh: tariffFor(hour),
  }),
);

export const SAMPLE_BATTERY: BatteryInput = {
  capacity_kwh: 120,
  initial_soc_kwh: 60,
  max_charge_kwh: 30,
  max_discharge_kwh: 30,
  efficiency: 0.95,
  min_reserve_kwh: 10,
};

/**
 * Deliberately paraphrased, with no keyword overlap with the directive names —
 * the interpreter has to understand them, not pattern match.
 */
export const SAMPLE_NOTES = [
  "The cleaning crew will be up on the block C roof from one in the afternoon till three, so that array will be giving us maybe a fifth less than usual.",
  "Don't let the pack drop under a quarter of its capacity once the sun goes down.",
  "Inverter techs need the batteries left alone on the charging side through the whole lunch period, eleven to two.",
  "We are on a load agreement tonight: from six to nine in the evening nothing over forty five units off the utility.",
  "Reminder that the fest volunteers get their lunch coupons at the admin building.",
];

export const SAMPLE_SCENARIO_ID = "bup-campus-day-1";
