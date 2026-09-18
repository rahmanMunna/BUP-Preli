import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { OptimizerRequest } from '../schemas/optimizer-contract.js';
import { LocalOptimizer } from './local-optimizer.js';
import { OptimizerClient } from './optimizer.client.js';

const request: OptimizerRequest = {
  scenario_id: 'client-spec',
  hours: [
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
  directives: [
    {
      note_index: 0,
      directive_type: 'no_charge_window',
      structured_adjustment: { hours: [18] },
    },
  ],
};

/** Stands in for the Python optimizer on an ephemeral port. */
async function startStub(
  handler: (body: OptimizerRequest) => { status: number; payload: unknown },
): Promise<{ server: Server; url: string; received: OptimizerRequest[] }> {
  const received: OptimizerRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as OptimizerRequest;
      received.push(body);
      const { status, payload } = handler(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, received };
}

function clientFor(
  url: string,
  overrides: Partial<AppConfig['optimizer']> = {},
): OptimizerClient {
  const optimizer: AppConfig['optimizer'] = {
    url,
    path: '/optimize',
    timeoutMs: 2_000,
    maxRetries: 0,
    fallbackEnabled: true,
    ...overrides,
  };
  const configService = {
    get: () => optimizer,
  } as unknown as ConfigService<AppConfig, true>;

  return new OptimizerClient(configService, new LocalOptimizer());
}

describe('OptimizerClient', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it('sends the validated directives and returns the optimizer schedule', async () => {
    const stub = await startStub((body) => ({
      status: 200,
      payload: {
        hourly_plan: body.hours.map((hour) => ({
          hour: hour.hour,
          demand_kwh: hour.demand_kwh,
          solar_kwh: hour.solar_kwh,
          solar_used_kwh: 0,
          battery_charge_kwh: 0,
          battery_discharge_kwh: 10,
          battery_soc_kwh: 40,
          grid_kwh: hour.demand_kwh - 10,
          tariff_bdt_per_kwh: hour.tariff_bdt_per_kwh,
          cost_bdt: (hour.demand_kwh - 10) * hour.tariff_bdt_per_kwh,
        })),
      },
    }));
    server = stub.server;

    const result = await clientFor(stub.url).optimize(request);

    expect(result.engine).toBe('python-optimizer');
    expect(result.hourly_plan).toHaveLength(2);
    expect(result.hourly_plan[0].grid_kwh).toBe(50);
    expect(stub.received[0].directives).toEqual(request.directives);
  });

  it('fills in fields the optimizer omitted rather than failing', async () => {
    const stub = await startStub(() => ({
      status: 200,
      payload: { hourly_plan: [{ hour: 18, grid_kwh: 42 }, { hour: 19 }] },
    }));
    server = stub.server;

    const result = await clientFor(stub.url).optimize(request);

    expect(result.engine).toBe('python-optimizer');
    // Tariff is recovered from the request, cost derived from it.
    expect(result.hourly_plan[0].cost_bdt).toBeCloseTo(42 * 14, 3);
    expect(result.hourly_plan[1].grid_kwh).toBe(0);
  });

  it('falls back locally when the optimizer answers off-contract', async () => {
    const stub = await startStub(() => ({
      status: 200,
      payload: { message: 'no plan for you' },
    }));
    server = stub.server;

    const result = await clientFor(stub.url).optimize(request);

    expect(result.engine).toBe('local-fallback');
    expect(result.hourly_plan).toHaveLength(2);
  });

  it('falls back locally when the optimizer errors', async () => {
    const stub = await startStub(() => ({
      status: 500,
      payload: { detail: 'solver crashed' },
    }));
    server = stub.server;

    const result = await clientFor(stub.url).optimize(request);

    expect(result.engine).toBe('local-fallback');
    // The fallback still honours the directive that was sent.
    expect(result.hourly_plan[0].battery_charge_kwh).toBe(0);
  });

  it('raises 503 instead of falling back when the fallback is disabled', async () => {
    const client = clientFor('http://127.0.0.1:9', { fallbackEnabled: false });

    await expect(client.optimize(request)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
