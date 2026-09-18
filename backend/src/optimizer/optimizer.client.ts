import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  describeHttpError,
  isRetryableHttpError,
} from '../common/utils/http-error.js';
import { withRetry } from '../common/utils/retry.js';
import type { AppConfig } from '../config/configuration.js';
import type { HourlyPlanEntry } from '../schemas/optimize-response.dto.js';
import type {
  OptimizerRequest,
  OptimizerResult,
} from '../schemas/optimizer-contract.js';
import { LocalOptimizer } from './local-optimizer.js';

/** Raised when the optimizer answered, but not with a usable schedule. */
class OptimizerContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimizerContractError';
  }
}

/**
 * HTTP client for the Python optimizer service.
 *
 * Failures are retried with backoff; once retries are exhausted the local
 * fallback engine produces a feasible plan so the public API keeps its
 * contract. Set `OPTIMIZER_FALLBACK_ENABLED=false` to surface 503 instead.
 */
@Injectable()
export class OptimizerClient {
  private readonly logger = new Logger(OptimizerClient.name);
  private readonly config: AppConfig['optimizer'];
  private readonly http: AxiosInstance;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly localOptimizer: LocalOptimizer,
  ) {
    this.config = configService.get('optimizer', { infer: true });
    this.http = axios.create({
      baseURL: this.config.url,
      timeout: this.config.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  async optimize(request: OptimizerRequest): Promise<OptimizerResult> {
    const startedAt = Date.now();

    try {
      const result = await withRetry(
        async () => {
          const { data } = await this.http.post(this.config.path, request);
          return this.assertResult(data, request);
        },
        {
          retries: this.config.maxRetries,
          label: `optimizer:${this.config.url}${this.config.path}`,
          logger: this.logger,
          shouldRetry: (error) =>
            error instanceof OptimizerContractError ||
            isRetryableHttpError(error),
        },
      );

      this.logger.log(
        `Optimizer returned ${result.hourly_plan.length} hour(s) in ${Date.now() - startedAt}ms`,
      );
      return { ...result, engine: 'python-optimizer' };
    } catch (error) {
      const reason = describeHttpError(error);
      this.logger.error(`Optimizer unavailable: ${reason}`);

      if (!this.config.fallbackEnabled) {
        throw new ServiceUnavailableException(
          `Optimizer service is unavailable: ${reason}`,
        );
      }

      this.logger.warn('Falling back to the local heuristic dispatcher');
      return this.localOptimizer.run(request);
    }
  }

  /** Lightweight reachability probe used by `/health/details`. */
  async isReachable(): Promise<boolean> {
    try {
      await this.http.get('/health', { timeout: 2_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Normalises the optimizer payload and rejects anything unusable. */
  private assertResult(
    data: unknown,
    request: OptimizerRequest,
  ): OptimizerResult {
    if (!data || typeof data !== 'object') {
      throw new OptimizerContractError('optimizer response was not an object');
    }

    const body = data as Record<string, unknown>;
    const rawPlan = body.hourly_plan ?? body.plan ?? body.schedule;

    if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
      throw new OptimizerContractError(
        'optimizer response is missing a non-empty "hourly_plan"',
      );
    }

    const tariffByHour = new Map(
      request.hours.map((hour) => [hour.hour, hour.tariff_bdt_per_kwh]),
    );

    const hourly_plan: HourlyPlanEntry[] = rawPlan.map((entry, index) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const hour = num(
        row.hour ?? row.hour_index ?? request.hours[index]?.hour,
      );
      if (hour === null) {
        throw new OptimizerContractError(
          `hourly_plan[${index}] has no usable "hour"`,
        );
      }
      const grid = num(row.grid_kwh ?? row.grid) ?? 0;
      const tariff =
        num(row.tariff_bdt_per_kwh ?? row.tariff) ??
        tariffByHour.get(hour) ??
        0;

      return {
        hour,
        demand_kwh: num(row.demand_kwh ?? row.demand) ?? 0,
        solar_kwh: num(row.solar_kwh ?? row.solar) ?? 0,
        solar_used_kwh: num(row.solar_used_kwh) ?? 0,
        battery_charge_kwh: num(row.battery_charge_kwh ?? row.charge_kwh) ?? 0,
        battery_discharge_kwh:
          num(row.battery_discharge_kwh ?? row.discharge_kwh) ?? 0,
        battery_soc_kwh: num(row.battery_soc_kwh ?? row.soc_kwh) ?? 0,
        grid_kwh: grid,
        tariff_bdt_per_kwh: tariff,
        cost_bdt: num(row.cost_bdt ?? row.cost) ?? grid * tariff,
      };
    });

    return {
      hourly_plan,
      total_grid_kwh: num(body.total_grid_kwh) ?? undefined,
      total_cost_bdt: num(body.total_cost_bdt) ?? undefined,
      peak_grid_kwh: num(body.peak_grid_kwh) ?? undefined,
      plan_summary:
        typeof body.plan_summary === 'string' ? body.plan_summary : undefined,
    };
  }
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
