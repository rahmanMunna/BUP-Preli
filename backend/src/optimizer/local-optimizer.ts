import { Injectable, Logger } from '@nestjs/common';
import type { HourlyPlanEntry } from '../schemas/optimize-response.dto.js';
import type {
  OptimizerRequest,
  OptimizerResult,
} from '../schemas/optimizer-contract.js';

interface SimulationResult {
  plan: HourlyPlanEntry[];
  violations: string[];
  /** Energy the pack gained from grid charging (after charging losses). */
  gridStoredKwh: number;
}

interface HourConstraints {
  solarFactorLoss: number;
  chargeBlocked: boolean;
  dischargeBlocked: boolean;
  gridCapKwh?: number;
  reserveKwh: number;
}

/**
 * Deterministic fallback dispatcher.
 *
 * The Python service owns the real optimization. This engine exists so that a
 * cold, crashed or unreachable optimizer still yields a feasible, directive
 * respecting schedule instead of a 5xx during judging.
 *
 * Strategy:
 *   1. Free solar serves demand first; the surplus charges the battery.
 *   2. The battery's usable energy is allocated to the most expensive hours,
 *      water-filled inside each price group so a price tie shaves the peak
 *      evenly instead of emptying the pack into whichever hour came first.
 *   3. Grid charging is allowed only when it pays for itself after losses, and
 *      only up to the import peak the plan already has — arbitrage may fill a
 *      valley, never build a taller peak.
 */
@Injectable()
export class LocalOptimizer {
  private readonly logger = new Logger(LocalOptimizer.name);

  run(request: OptimizerRequest): OptimizerResult {
    const hours = [...request.hours].sort((a, b) => a.hour - b.hour);
    const constraints = this.buildConstraints(request, hours);

    // The allocation needs to know how much energy the pack will hold, and
    // grid charging only happens once an allocation exists. Two rounds settle
    // it: plan on solar alone, see what arbitrage bought, then re-allocate
    // including that energy so it lands in the expensive hours too.
    let run = this.plan(request, hours, constraints, 0);
    if (run.gridStoredKwh > 1e-6) {
      run = this.plan(request, hours, constraints, run.gridStoredKwh);
    }

    const { plan, violations } = run;
    if (violations.length) {
      this.logger.warn(`Infeasible grid caps: ${violations.join('; ')}`);
    }

    return {
      hourly_plan: plan,
      engine: 'local-fallback',
      plan_summary: violations.length
        ? `Fallback schedule could not fully honour every grid cap: ${violations.join('; ')}.`
        : undefined,
    };
  }

  /**
   * One allocate-then-dispatch round. `extraStoredKwh` is energy the pack is
   * expected to gain from grid charging on top of solar.
   */
  private plan(
    request: OptimizerRequest,
    hours: OptimizerRequest['hours'],
    constraints: Map<number, HourConstraints>,
    extraStoredKwh: number,
  ): SimulationResult {
    const budgets = this.allocateDischarge(
      request,
      hours,
      constraints,
      extraStoredKwh,
    );

    // A first dispatch without grid charging shows the highest import the
    // campus still needs; charging may then fill valleys up to that level.
    const ceiling = this.simulate(
      request,
      hours,
      constraints,
      budgets,
      0,
    ).plan.reduce((peak, row) => Math.max(peak, row.grid_kwh), 0);

    return this.simulate(request, hours, constraints, budgets, ceiling);
  }

  /** Demand left for the battery and the grid once solar has been used. */
  private netDemand(
    hour: OptimizerRequest['hours'][number],
    limits: HourConstraints,
  ): number {
    const solar = hour.solar_kwh * (1 - limits.solarFactorLoss);
    return Math.max(0, hour.demand_kwh - Math.min(solar, hour.demand_kwh));
  }

  /**
   * Decides how much the battery should deliver in each hour: the most
   * expensive hours are served first, and a price tie is water-filled so the
   * group's peak comes down evenly.
   */
  private allocateDischarge(
    request: OptimizerRequest,
    hours: OptimizerRequest['hours'],
    constraints: Map<number, HourConstraints>,
    extraStoredKwh: number,
  ): Map<number, number> {
    const battery = request.battery;
    const budgets = new Map<number, number>(
      hours.map((hour) => [hour.hour, 0]),
    );

    const globalFloor = hours.reduce(
      (floor, hour) => Math.max(floor, constraints.get(hour.hour)!.reserveKwh),
      0,
    );

    // Energy the pack can realistically deliver: what it holds above the floor
    // plus the surplus solar it is expected to absorb during the day.
    let soc = clamp(battery.initial_soc_kwh, 0, battery.capacity_kwh);
    let solarCharge = 0;
    for (const hour of hours) {
      const limits = constraints.get(hour.hour)!;
      if (limits.chargeBlocked) continue;
      const solar = hour.solar_kwh * (1 - limits.solarFactorLoss);
      const accepted = Math.min(
        Math.max(0, solar - hour.demand_kwh),
        battery.max_charge_kwh,
        (battery.capacity_kwh - soc) / battery.efficiency,
      );
      if (accepted > 0) {
        solarCharge += accepted * battery.efficiency;
        soc += accepted * battery.efficiency;
      }
    }

    let available = Math.max(
      0,
      clamp(battery.initial_soc_kwh, 0, battery.capacity_kwh) -
        globalFloor +
        solarCharge +
        extraStoredKwh,
    );
    if (available <= 0) return budgets;

    // Group the dischargeable hours by price, most expensive first.
    const groups = new Map<number, OptimizerRequest['hours']>();
    for (const hour of hours) {
      const limits = constraints.get(hour.hour)!;
      if (limits.dischargeBlocked) continue;
      if (this.netDemand(hour, limits) <= 0) continue;
      const bucket = groups.get(hour.tariff_bdt_per_kwh) ?? [];
      bucket.push(hour);
      groups.set(hour.tariff_bdt_per_kwh, bucket);
    }

    const capacityOf = (hour: OptimizerRequest['hours'][number]) =>
      Math.min(
        this.netDemand(hour, constraints.get(hour.hour)!),
        battery.max_discharge_kwh,
      );

    for (const tariff of [...groups.keys()].sort((a, b) => b - a)) {
      if (available <= 1e-9) break;
      const group = groups.get(tariff)!;
      const groupCapacity = group.reduce(
        (total, hour) => total + capacityOf(hour),
        0,
      );

      if (groupCapacity <= available + 1e-9) {
        // The whole group can be covered — no need to ration it.
        for (const hour of group) budgets.set(hour.hour, capacityOf(hour));
        available -= groupCapacity;
        continue;
      }

      // Ration by water level: shave every hour in the group down to `level`.
      const level = this.waterLevel(group, constraints, battery, available);
      let spent = 0;
      for (const hour of group) {
        const net = this.netDemand(hour, constraints.get(hour.hour)!);
        const share = clamp(net - level, 0, capacityOf(hour));
        budgets.set(hour.hour, share);
        spent += share;
      }
      available = Math.max(0, available - spent);
    }

    return budgets;
  }

  /** Binary search for the import level that exactly spends `available` kWh. */
  private waterLevel(
    group: OptimizerRequest['hours'],
    constraints: Map<number, HourConstraints>,
    battery: OptimizerRequest['battery'],
    available: number,
  ): number {
    const nets = group.map((hour) =>
      this.netDemand(hour, constraints.get(hour.hour)!),
    );
    let low = 0;
    let high = Math.max(...nets);

    const shavedAt = (level: number) =>
      nets.reduce(
        (total, net) =>
          total + clamp(net - level, 0, battery.max_discharge_kwh),
        0,
      );

    for (let i = 0; i < 60; i += 1) {
      const mid = (low + high) / 2;
      if (shavedAt(mid) > available) low = mid;
      else high = mid;
    }
    return high;
  }

  /**
   * Chronological dispatch honouring the allocation, the directive windows and
   * the state-of-charge trajectory.
   */
  private simulate(
    request: OptimizerRequest,
    hours: OptimizerRequest['hours'],
    constraints: Map<number, HourConstraints>,
    budgets: Map<number, number>,
    gridImportCeiling: number,
  ): SimulationResult {
    const battery = request.battery;
    const tariffs = hours.map((hour) => hour.tariff_bdt_per_kwh);

    // A reserve required later must be protected now, so the floor each hour is
    // the strongest floor still ahead of us.
    const forwardFloors = hours.map(
      (hour) => constraints.get(hour.hour)!.reserveKwh,
    );
    for (let i = forwardFloors.length - 2; i >= 0; i -= 1) {
      forwardFloors[i] = Math.max(forwardFloors[i], forwardFloors[i + 1]);
    }

    // Energy already promised to later (more expensive) hours.
    const futureBudget = hours.map(() => 0);
    for (let i = hours.length - 2; i >= 0; i -= 1) {
      futureBudget[i] =
        futureBudget[i + 1] + (budgets.get(hours[i + 1].hour) ?? 0);
    }

    let soc = clamp(battery.initial_soc_kwh, 0, battery.capacity_kwh);
    let gridStoredKwh = 0;
    const plan: HourlyPlanEntry[] = [];
    const violations: string[] = [];

    for (const [index, hour] of hours.entries()) {
      const limits = constraints.get(hour.hour)!;
      const floor = Math.min(forwardFloors[index], battery.capacity_kwh);
      const promised = Math.min(
        battery.capacity_kwh,
        floor + futureBudget[index],
      );

      const solarAvailable = hour.solar_kwh * (1 - limits.solarFactorLoss);
      const solarUsed = Math.min(solarAvailable, hour.demand_kwh);
      let net = hour.demand_kwh - solarUsed;
      const surplusSolar = solarAvailable - solarUsed;

      let chargeKwh = 0;
      let dischargeKwh = 0;

      // 1. Surplus solar is free energy — store whatever the battery accepts.
      if (!limits.chargeBlocked && surplusSolar > 0) {
        const accepted = Math.min(
          surplusSolar,
          battery.max_charge_kwh,
          (battery.capacity_kwh - soc) / battery.efficiency,
        );
        if (accepted > 0) {
          chargeKwh += accepted;
          soc += accepted * battery.efficiency;
        }
      }

      /** Energy the pack may release now; `respectPromises` protects later hours. */
      const dischargeable = (respectPromises: boolean) =>
        limits.dischargeBlocked
          ? 0
          : Math.max(
              0,
              Math.min(
                battery.max_discharge_kwh - dischargeKwh,
                soc - (respectPromises ? promised : floor),
              ),
            );

      // 2. Spend this hour's allocation, never eating into what later, more
      //    expensive hours were promised.
      if (net > 0) {
        const delivered = Math.min(
          net,
          budgets.get(hour.hour) ?? 0,
          dischargeable(true),
        );
        if (delivered > 0) {
          dischargeKwh += delivered;
          soc -= delivered;
          net -= delivered;
        }
      }

      // 3. Honour a grid cap even where that was not the plan: drain further.
      if (limits.gridCapKwh !== undefined && net > limits.gridCapKwh) {
        const delivered = Math.min(
          net - limits.gridCapKwh,
          dischargeable(false),
        );
        if (delivered > 0) {
          dischargeKwh += delivered;
          soc -= delivered;
          net -= delivered;
        }
        if (net > limits.gridCapKwh + 1e-6) {
          violations.push(
            `hour ${hour.hour} needed ${round(net)} kWh from the grid against a ${round(limits.gridCapKwh)} kWh cap`,
          );
        }
      }

      // 4. Grid charging: only when it beats the best remaining price after
      //    losses, never in an hour we just discharged (that round trip only
      //    burns efficiency), and never above the import peak already planned.
      let gridChargeKwh = 0;
      const bestFutureTariff = Math.max(
        ...tariffs.slice(index + 1),
        Number.NEGATIVE_INFINITY,
      );
      const arbitragePays =
        Number.isFinite(bestFutureTariff) &&
        hour.tariff_bdt_per_kwh / battery.efficiency < bestFutureTariff;

      if (
        gridImportCeiling > 0 &&
        !limits.chargeBlocked &&
        dischargeKwh === 0 &&
        arbitragePays
      ) {
        const capRoom =
          limits.gridCapKwh === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(0, limits.gridCapKwh - net);
        const accepted = Math.min(
          battery.max_charge_kwh - chargeKwh,
          (battery.capacity_kwh - soc) / battery.efficiency,
          capRoom,
          Math.max(0, gridImportCeiling - net),
        );
        if (accepted > 0) {
          gridChargeKwh = accepted;
          chargeKwh += accepted;
          soc += accepted * battery.efficiency;
          gridStoredKwh += accepted * battery.efficiency;
        }
      }

      const gridKwh = round(net + gridChargeKwh);
      plan.push({
        hour: hour.hour,
        demand_kwh: round(hour.demand_kwh),
        solar_kwh: round(solarAvailable),
        solar_used_kwh: round(solarUsed),
        battery_charge_kwh: round(chargeKwh),
        battery_discharge_kwh: round(dischargeKwh),
        battery_soc_kwh: round(clamp(soc, 0, battery.capacity_kwh)),
        grid_kwh: gridKwh,
        tariff_bdt_per_kwh: hour.tariff_bdt_per_kwh,
        cost_bdt: round(gridKwh * hour.tariff_bdt_per_kwh),
      });
    }

    return { plan, violations, gridStoredKwh };
  }

  /** Collapses all directives into per-hour constraints. */
  private buildConstraints(
    request: OptimizerRequest,
    hours: OptimizerRequest['hours'],
  ): Map<number, HourConstraints> {
    const constraints = new Map<number, HourConstraints>();
    for (const hour of hours) {
      constraints.set(hour.hour, {
        solarFactorLoss: 0,
        chargeBlocked: false,
        dischargeBlocked: false,
        reserveKwh: clamp(
          request.battery.min_reserve_kwh,
          0,
          request.battery.capacity_kwh,
        ),
      });
    }

    for (const directive of request.directives) {
      const adjustment = directive.structured_adjustment as Record<
        string,
        unknown
      >;
      const targetHours = Array.isArray(adjustment.hours)
        ? (adjustment.hours as number[])
        : [...constraints.keys()];

      for (const hour of targetHours) {
        const limits = constraints.get(hour);
        if (!limits) continue;

        switch (directive.directive_type) {
          case 'solar_reduction':
            // Overlapping reductions: keep the most severe one.
            limits.solarFactorLoss = clamp(
              Math.max(limits.solarFactorLoss, Number(adjustment.factor) || 0),
              0,
              1,
            );
            break;
          case 'no_charge_window':
            limits.chargeBlocked = true;
            break;
          case 'no_discharge_window':
            limits.dischargeBlocked = true;
            break;
          case 'max_grid_window': {
            const cap = Number(adjustment.max_kwh);
            if (Number.isFinite(cap)) {
              limits.gridCapKwh =
                limits.gridCapKwh === undefined
                  ? cap
                  : Math.min(limits.gridCapKwh, cap);
            }
            break;
          }
          case 'minimum_battery_reserve': {
            const reserve = Number(adjustment.reserve_kwh);
            if (Number.isFinite(reserve)) {
              limits.reserveKwh = Math.max(
                limits.reserveKwh,
                clamp(reserve, 0, request.battery.capacity_kwh),
              );
            }
            break;
          }
        }
      }
    }

    return constraints;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
