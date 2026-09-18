import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** Payload key aliases tolerated on `POST /optimize-energy`. */
const TOP_LEVEL_ALIASES: Record<string, string[]> = {
  scenario_id: ['scenarioId', 'id'],
  operator_notes: ['operatorNotes', 'notes'],
  hours: ['hourly', 'hourly_data', 'timeseries', 'hour_data'],
  battery: ['battery_config', 'batteryConfig', 'storage'],
};

const HOUR_ALIASES: Record<string, string[]> = {
  hour: ['hour_index', 'hourIndex', 'h', 'index', 't'],
  demand_kwh: ['demand', 'load_kwh', 'load', 'demandKwh'],
  solar_kwh: ['solar', 'solar_generation_kwh', 'pv_kwh', 'solarKwh'],
  tariff_bdt_per_kwh: [
    'tariff',
    'tariff_bdt',
    'price',
    'price_bdt_per_kwh',
    'rate',
    'tariffBdtPerKwh',
  ],
};

const BATTERY_ALIASES: Record<string, string[]> = {
  capacity_kwh: ['capacity', 'usable_capacity_kwh', 'capacityKwh'],
  initial_soc_kwh: [
    'initial_soc',
    'soc_kwh',
    'start_soc_kwh',
    'initial_charge_kwh',
    'initialSocKwh',
  ],
  max_charge_kwh: ['max_charge_kw', 'charge_rate_kwh', 'max_charge_rate_kw'],
  max_discharge_kwh: [
    'max_discharge_kw',
    'discharge_rate_kwh',
    'max_discharge_rate_kw',
  ],
  efficiency: ['round_trip_efficiency', 'charge_efficiency'],
  min_reserve_kwh: ['min_reserve', 'min_soc_kwh', 'reserve_kwh'],
};

/**
 * Renames known payload aliases before validation runs.
 *
 * Aliases are resolved here rather than with DTO `@Transform` decorators
 * because class-transformer only visits keys that exist in the payload — a
 * transform declared on `demand_kwh` never fires when the judge sent `demand`.
 */
@Injectable()
export class NormalizeBodyMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    const body = request.body;
    if (!isRecord(body)) return next();

    applyAliases(body, TOP_LEVEL_ALIASES);

    if (Array.isArray(body.hours)) {
      for (const hour of body.hours) {
        if (isRecord(hour)) applyAliases(hour, HOUR_ALIASES);
      }
    }

    if (isRecord(body.battery)) applyAliases(body.battery, BATTERY_ALIASES);

    next();
  }
}

function applyAliases(
  target: Record<string, unknown>,
  aliases: Record<string, string[]>,
): void {
  for (const [canonical, candidates] of Object.entries(aliases)) {
    if (target[canonical] !== undefined && target[canonical] !== null) continue;
    for (const alias of candidates) {
      if (target[alias] !== undefined && target[alias] !== null) {
        target[canonical] = target[alias];
        break;
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
