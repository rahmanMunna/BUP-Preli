import { beforeEach, describe, expect, it } from 'vitest';
import type { OptimizerRequest } from '../schemas/optimizer-contract.js';
import { LocalOptimizer } from './local-optimizer.js';

function scenario(overrides: Partial<OptimizerRequest> = {}): OptimizerRequest {
  return {
    scenario_id: 'test',
    hours: [
      { hour: 10, demand_kwh: 40, solar_kwh: 30, tariff_bdt_per_kwh: 6 },
      { hour: 11, demand_kwh: 45, solar_kwh: 35, tariff_bdt_per_kwh: 6 },
      { hour: 18, demand_kwh: 60, solar_kwh: 0, tariff_bdt_per_kwh: 14 },
      { hour: 19, demand_kwh: 65, solar_kwh: 0, tariff_bdt_per_kwh: 14 },
    ],
    battery: {
      capacity_kwh: 100,
      initial_soc_kwh: 50,
      max_charge_kwh: 25,
      max_discharge_kwh: 25,
      efficiency: 0.95,
      min_reserve_kwh: 0,
    },
    directives: [],
    ...overrides,
  };
}

describe('LocalOptimizer', () => {
  let optimizer: LocalOptimizer;

  beforeEach(() => {
    optimizer = new LocalOptimizer();
  });

  it('serves demand from solar before the grid', () => {
    const plan = optimizer.run(scenario()).hourly_plan;
    const morning = plan.find((row) => row.hour === 10)!;

    expect(morning.solar_used_kwh).toBe(30);
    expect(morning.grid_kwh).toBeLessThan(morning.demand_kwh);
  });

  it('discharges the battery into the expensive evening hours', () => {
    const plan = optimizer.run(scenario()).hourly_plan;
    const evening = plan.filter((row) => row.hour >= 18);

    expect(
      evening.reduce((total, row) => total + row.battery_discharge_kwh, 0),
    ).toBeGreaterThan(0);
  });

  it('never charges during a no_charge_window', () => {
    const result = optimizer.run(
      scenario({
        directives: [
          {
            note_index: 0,
            directive_type: 'no_charge_window',
            structured_adjustment: { hours: [10, 11] },
          },
        ],
      }),
    );

    for (const row of result.hourly_plan.filter((entry) => entry.hour <= 11)) {
      expect(row.battery_charge_kwh).toBe(0);
    }
  });

  it('never discharges during a no_discharge_window', () => {
    const result = optimizer.run(
      scenario({
        directives: [
          {
            note_index: 0,
            directive_type: 'no_discharge_window',
            structured_adjustment: { hours: [18, 19] },
          },
        ],
      }),
    );

    for (const row of result.hourly_plan.filter((entry) => entry.hour >= 18)) {
      expect(row.battery_discharge_kwh).toBe(0);
    }
  });

  it('keeps the state of charge above a minimum reserve', () => {
    const result = optimizer.run(
      scenario({
        directives: [
          {
            note_index: 0,
            directive_type: 'minimum_battery_reserve',
            structured_adjustment: { reserve_kwh: 40 },
          },
        ],
      }),
    );

    for (const row of result.hourly_plan) {
      expect(row.battery_soc_kwh).toBeGreaterThanOrEqual(40 - 1e-6);
    }
  });

  it('applies a solar reduction factor to the available solar', () => {
    const result = optimizer.run(
      scenario({
        directives: [
          {
            note_index: 0,
            directive_type: 'solar_reduction',
            structured_adjustment: { hours: [10], factor: 0.5 },
          },
        ],
      }),
    );

    expect(result.hourly_plan.find((row) => row.hour === 10)!.solar_kwh).toBe(
      15,
    );
  });

  it('respects a grid cap when the battery can cover the gap', () => {
    const result = optimizer.run(
      scenario({
        directives: [
          {
            note_index: 0,
            directive_type: 'max_grid_window',
            structured_adjustment: { hours: [18], max_kwh: 40 },
          },
        ],
      }),
    );

    expect(
      result.hourly_plan.find((row) => row.hour === 18)!.grid_kwh,
    ).toBeLessThanOrEqual(40 + 1e-6);
  });

  it('reports the fallback engine and priced, balanced rows', () => {
    const result = optimizer.run(scenario());

    expect(result.engine).toBe('local-fallback');
    for (const row of result.hourly_plan) {
      expect(row.cost_bdt).toBeCloseTo(
        row.grid_kwh * row.tariff_bdt_per_kwh,
        3,
      );
      expect(row.grid_kwh).toBeGreaterThanOrEqual(0);
      // Energy balance: supply meets demand plus whatever was stored.
      expect(
        row.solar_used_kwh + row.battery_discharge_kwh + row.grid_kwh,
      ).toBeCloseTo(row.demand_kwh + gridCharge(row), 3);
    }
  });

  it('spreads the battery evenly across equally priced peak hours', () => {
    // 50 kWh usable against three identically priced hours: shaving one of them
    // to the floor would leave a 65 kWh peak, water-filling leaves ~50.
    const result = optimizer.run(
      scenario({
        hours: [
          { hour: 17, demand_kwh: 20, solar_kwh: 0, tariff_bdt_per_kwh: 6 },
          { hour: 18, demand_kwh: 60, solar_kwh: 0, tariff_bdt_per_kwh: 14 },
          { hour: 19, demand_kwh: 65, solar_kwh: 0, tariff_bdt_per_kwh: 14 },
          { hour: 20, demand_kwh: 55, solar_kwh: 0, tariff_bdt_per_kwh: 14 },
        ],
      }),
    );

    const peakHours = result.hourly_plan.filter((row) => row.hour >= 18);
    const peak = Math.max(...peakHours.map((row) => row.grid_kwh));
    expect(peak).toBeLessThan(55);
    for (const row of peakHours) {
      expect(row.battery_discharge_kwh).toBeGreaterThan(0);
    }
  });

  it('never charges from the grid in an hour it also discharges', () => {
    const result = optimizer.run(scenario());

    for (const row of result.hourly_plan) {
      if (row.battery_discharge_kwh > 0) {
        expect(gridCharge(row)).toBe(0);
      }
    }
  });

  it('does not let arbitrage charging create a taller peak than the demand it shaves', () => {
    const cheapMorning = scenario({
      hours: [
        { hour: 6, demand_kwh: 10, solar_kwh: 0, tariff_bdt_per_kwh: 4 },
        { hour: 7, demand_kwh: 12, solar_kwh: 0, tariff_bdt_per_kwh: 4 },
        { hour: 19, demand_kwh: 60, solar_kwh: 0, tariff_bdt_per_kwh: 18 },
      ],
    });

    const result = optimizer.run(cheapMorning);
    const peak = Math.max(...result.hourly_plan.map((row) => row.grid_kwh));
    const worstNetDemand = Math.max(
      ...cheapMorning.hours.map((hour) => hour.demand_kwh - hour.solar_kwh),
    );

    expect(peak).toBeLessThanOrEqual(worstNetDemand + 1e-6);
  });
});

/** Portion of the hour's charging that had to come from the grid. */
function gridCharge(row: {
  battery_charge_kwh: number;
  solar_kwh: number;
  solar_used_kwh: number;
}): number {
  const surplusSolar = row.solar_kwh - row.solar_used_kwh;
  return Math.max(0, row.battery_charge_kwh - surplusSolar);
}
