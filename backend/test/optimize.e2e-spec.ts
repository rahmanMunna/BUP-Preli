import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/common/app-setup.js';
import {
  LlmService,
  type LlmInterpretationResult,
} from '../src/llm/llm.service.js';

/** Scenario payload in the exact shape documented for the judge. */
const scenario = {
  scenario_id: 'campus-day-1',
  operator_notes: [
    'Rooftop panels on block B are being washed between 1pm and 3pm, expect about 20% less output.',
    'Please keep at least 20 kWh in the battery for the server room overnight.',
    'The canteen is serving biryani today.',
  ],
  hours: [
    { hour: 10, demand_kwh: 40, solar_kwh: 30, tariff_bdt_per_kwh: 6.5 },
    { hour: 13, demand_kwh: 55, solar_kwh: 45, tariff_bdt_per_kwh: 6.5 },
    { hour: 14, demand_kwh: 58, solar_kwh: 40, tariff_bdt_per_kwh: 6.5 },
    { hour: 19, demand_kwh: 70, solar_kwh: 0, tariff_bdt_per_kwh: 14.2 },
  ],
  battery: {
    capacity_kwh: 100,
    initial_soc_kwh: 60,
    max_charge_kwh: 25,
    max_discharge_kwh: 25,
    efficiency: 0.95,
    min_reserve_kwh: 0,
  },
};

const interpretedNotes: LlmInterpretationResult = {
  provider: 'gemini',
  degraded: false,
  latency_ms: 1,
  interpretations: [
    {
      note_index: 0,
      applies: true,
      directive_type: 'solar_reduction',
      structured_adjustment: { hours: [13, 14], factor: 0.2 },
      explanation: 'Panel washing costs 20% of the output at 13:00 and 14:00.',
    },
    {
      note_index: 1,
      applies: true,
      directive_type: 'minimum_battery_reserve',
      structured_adjustment: { reserve_kwh: 20 },
      explanation: 'The server room needs a 20 kWh floor.',
    },
    {
      note_index: 2,
      applies: false,
      directive_type: 'no_op',
      structured_adjustment: {},
      explanation: 'Catering information does not change the energy plan.',
    },
  ],
};

async function createApp(
  interpret: LlmService['interpret'],
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LlmService)
    .useValue({ interpret, isConfigured: true })
    .compile();

  const app = applyGlobalSetup(moduleRef.createNestApplication());
  await app.init();
  return app;
}

describe('GridWise API (e2e)', () => {
  let app: INestApplication;

  beforeAll(() => {
    // No optimizer service in the test environment: the request must still
    // succeed through the local fallback dispatcher.
    process.env.OPTIMIZER_URL = 'http://127.0.0.1:9';
    process.env.OPTIMIZER_MAX_RETRIES = '0';
    process.env.OPTIMIZER_TIMEOUT_MS = '500';
    process.env.OPTIMIZER_FALLBACK_ENABLED = 'true';
  });

  afterEach(async () => {
    await app?.close();
  });

  it('GET /health returns ok', async () => {
    app = await createApp(async () => interpretedNotes);

    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('POST /optimize-energy returns a complete, consistent schedule', async () => {
    app = await createApp(async () => interpretedNotes);

    const response = await request(app.getHttpServer())
      .post('/optimize-energy')
      .send(scenario)
      .expect(200);

    const body = response.body;
    expect(body.scenario_id).toBe('campus-day-1');
    expect(body.directive_interpretation).toHaveLength(
      scenario.operator_notes.length,
    );
    expect(
      body.directive_interpretation.map((item: any) => item.note_index),
    ).toEqual([0, 1, 2]);
    expect(body.hourly_plan).toHaveLength(scenario.hours.length);
    expect(typeof body.plan_summary).toBe('string');
    expect(body.plan_summary.length).toBeGreaterThan(0);

    const totalGrid = body.hourly_plan.reduce(
      (sum: number, row: any) => sum + row.grid_kwh,
      0,
    );
    expect(body.total_grid_kwh).toBeCloseTo(totalGrid, 2);
    expect(body.peak_grid_kwh).toBeCloseTo(
      Math.max(...body.hourly_plan.map((row: any) => row.grid_kwh)),
      2,
    );
    expect(body.total_cost_bdt).toBeGreaterThan(0);

    // The solar_reduction directive must be visible in the plan: 45 kWh * 0.8.
    expect(
      body.hourly_plan.find((row: any) => row.hour === 13).solar_kwh,
    ).toBeCloseTo(36, 3);
    // The reserve floor must hold all day.
    for (const row of body.hourly_plan) {
      expect(row.battery_soc_kwh).toBeGreaterThanOrEqual(20 - 1e-6);
    }
  });

  it('accepts alias field names from a differently spelled payload', async () => {
    app = await createApp(async () => ({
      ...interpretedNotes,
      interpretations: [],
    }));

    const response = await request(app.getHttpServer())
      .post('/optimize-energy')
      .send({
        scenarioId: 'aliased',
        notes: [],
        hourly: [{ hour_index: 8, demand: 20, solar: 5, tariff: 7 }],
        battery: { capacity: 50, initial_soc: 10 },
      })
      .expect(200);

    expect(response.body.scenario_id).toBe('aliased');
    expect(response.body.hourly_plan).toHaveLength(1);
    expect(response.body.hourly_plan[0].hour).toBe(8);
  });

  it('rejects a malformed payload with 400 before calling the LLM', async () => {
    let called = false;
    app = await createApp(async () => {
      called = true;
      return interpretedNotes;
    });

    const response = await request(app.getHttpServer())
      .post('/optimize-energy')
      .send({
        scenario_id: 'bad',
        operator_notes: ['x'],
        hours: [],
        battery: {},
      })
      .expect(400);

    expect(called).toBe(false);
    expect(response.body.statusCode).toBe(400);
    expect(Array.isArray(response.body.message)).toBe(true);
  });

  it('rejects an hour index outside 0-23', async () => {
    app = await createApp(async () => interpretedNotes);

    await request(app.getHttpServer())
      .post('/optimize-energy')
      .send({
        ...scenario,
        hours: [
          { hour: 24, demand_kwh: 10, solar_kwh: 0, tariff_bdt_per_kwh: 5 },
        ],
      })
      .expect(400);
  });

  it('still answers when every LLM provider is down', async () => {
    app = await createApp(async () => ({
      interpretations: [],
      provider: 'none' as const,
      degraded: true,
      latency_ms: 5,
    }));

    const response = await request(app.getHttpServer())
      .post('/optimize-energy')
      .send(scenario)
      .expect(200);

    expect(response.body.directive_interpretation).toHaveLength(3);
    for (const item of response.body.directive_interpretation) {
      expect(item.directive_type).toBe('no_op');
      expect(item.applies).toBe(false);
    }
    expect(response.body.hourly_plan).toHaveLength(scenario.hours.length);
  });
});
