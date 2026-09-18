# GridWise API — BUP CSE FEST 2026 Hackathon

NestJS service for **GridWise: Smart Campus Energy Optimization Challenge**.

This is the public API the judge calls. It receives a campus scenario, turns free
text operator notes into structured GridWise directives with an LLM, validates
those directives, hands the validated data to the Python optimizer service, and
returns the optimized 24-hour schedule.

```
judge ──POST /optimize-energy──▶ NestJS API
                                  │ 1. validate payload (class-validator)
                                  │ 2. operator_notes ──▶ Gemini Flash (fallback: OpenRouter)
                                  │ 3. validate directives (trust boundary)
                                  │ 4. directives ──axios──▶ Python optimizer
                                  ◀── hourly plan + totals + summary
```

---

## Endpoints

### `GET /health`

```json
{ "status": "ok" }
```

`GET /health/details` additionally reports uptime, whether an LLM key is
configured, and whether the optimizer service answers — useful while wiring the
two services together. It never fails, so `/health` stays a pure liveness
signal.

### `POST /optimize-energy`

Request:

```json
{
  "scenario_id": "bup-campus-day-1",
  "operator_notes": [
    "Maintenance washes the block B array from 1pm to 3pm, expect ~20% less solar.",
    "Keep at least 25 kWh in the battery after 9pm for the server room.",
    "The canteen is serving biryani today."
  ],
  "hours": [
    { "hour": 8, "demand_kwh": 32, "solar_kwh": 10, "tariff_bdt_per_kwh": 6.2 }
  ],
  "battery": {
    "capacity_kwh": 120,
    "initial_soc_kwh": 60,
    "max_charge_kwh": 30,
    "max_discharge_kwh": 30,
    "efficiency": 0.95,
    "min_reserve_kwh": 10
  }
}
```

Response:

```json
{
  "scenario_id": "bup-campus-day-1",
  "directive_interpretation": [
    {
      "note_index": 0,
      "applies": true,
      "directive_type": "solar_reduction",
      "structured_adjustment": { "hours": [13, 14], "factor": 0.2 },
      "explanation": "Array washing costs about 20% of output at 13:00 and 14:00."
    }
  ],
  "hourly_plan": [
    {
      "hour": 8,
      "demand_kwh": 32,
      "solar_kwh": 10,
      "solar_used_kwh": 10,
      "battery_charge_kwh": 0,
      "battery_discharge_kwh": 0,
      "battery_soc_kwh": 60,
      "grid_kwh": 22,
      "tariff_bdt_per_kwh": 6.2,
      "cost_bdt": 136.4
    }
  ],
  "total_grid_kwh": 0,
  "total_cost_bdt": 0,
  "peak_grid_kwh": 0,
  "plan_summary": "Applied 2 of 3 operator note(s) as directives. …"
}
```

`directive_interpretation` always contains **exactly one entry per operator
note**, in note order — notes are never skipped and never merged.
`hourly_plan` contains one row per hour supplied, sorted ascending.
`battery_soc_kwh` is the state of charge at the **end** of the hour.

Field aliases are accepted and normalised before validation, so a slightly
different payload spelling still works: `scenarioId`/`id`, `notes`,
`hourly`/`timeseries`, `hour_index`/`h`, `demand`, `solar`, `tariff`/`price`,
`capacity`, `initial_soc`, `max_charge_kw`, `min_reserve`.

Errors are always JSON:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["hours.hour must be an integer hour index"],
  "path": "/optimize-energy",
  "timestamp": "2026-02-01T10:00:00.000Z"
}
```

---

## Supported directives

The LLM may only produce these six types. Anything else is rejected by the
validator and downgraded to `no_op`.

| `directive_type` | `structured_adjustment` | Meaning |
| --- | --- | --- |
| `solar_reduction` | `{"hours":[13,14],"factor":0.2}` | Solar output in those hours becomes `solar * (1 - factor)`. `factor` is the **fraction lost** (0.2 = 20% less). |
| `minimum_battery_reserve` | `{"reserve_kwh":25}` (optional `"hours"`) | State of charge must never fall below the floor. `reserve_percent` is converted using battery capacity. |
| `no_charge_window` | `{"hours":[18,19,20]}` | Charging forbidden in those hours. |
| `no_discharge_window` | `{"hours":[9,10]}` | Discharging forbidden in those hours. |
| `max_grid_window` | `{"hours":[18,19],"max_kwh":45}` | Grid import capped at `max_kwh` in **each** listed hour. |
| `no_op` | `{}` | Note carries no actionable directive (`applies: false`). |

### Interpretation rules given to the model

Interpretation is semantic, not keyword matching — paraphrases, indirect
phrasing and slang are handled by the model, and the prompt fixes the ambiguous
conventions so results are reproducible:

- `"from A to B"` covers `A … B-1` (`10am to 2pm` → `[10,11,12,13]`);
  `"at A and B"` covers exactly those hours.
- Named windows: morning `6-11`, midday `11-14`, afternoon `12-17`,
  evening `18-22`, night `23,0-5`, business hours `9-17`, peak evening `18-22`.
- Hours are restricted to the hour indexes present in the scenario.
- Demand, solar, tariff and battery values are never modified by the model; it
  only emits a constraint describing the operator's instruction.

---

## Validation (the trust boundary)

`DirectiveValidatorService` treats every LLM field as untrusted:

- the response is parsed as JSON, with repair for code fences, prose, trailing
  commas and Python literals (`True`/`None`);
- `directive_type` must be one of the six supported values;
- `hours` must be integers in `0-23`, unique, ascending and inside the scenario
  horizon — duplicates and bad ordering are repaired and reported, out-of-range
  or non-numeric hours reject the directive;
- numeric fields (`factor`, `reserve_kwh`, `max_kwh`) must be finite and in
  range; `factor` accepts `0.2` or `20`, a reserve above capacity is clamped;
- any rejected directive is downgraded to `no_op` and the note is re-sent to the
  interpreter once in a targeted repair call, listing exactly what was wrong;
- every note that is still missing after that ends up as `no_op` — the response
  array is always complete.

A hallucinating model can therefore degrade the plan, but never corrupt it.

---

## Resilience

| Failure | Behaviour |
| --- | --- |
| Gemini error / timeout / rate limit | Retried with exponential backoff and jitter (`LLM_MAX_RETRIES`), then OpenRouter. |
| Both LLM providers down, or no API key | Every note becomes `no_op` with an explicit explanation; the schedule is still optimized and returned with HTTP 200. |
| Malformed LLM JSON | Repaired (fences, prose, trailing commas, literals); if still unusable the call is retried, then the fallback provider is tried. |
| Missing or invalid directives | One targeted repair call for just those notes, then `no_op`. |
| Optimizer service down or answering off-contract | Retried with backoff, then the built-in heuristic dispatcher produces a feasible, directive-respecting plan (`engine: local-fallback`). Set `OPTIMIZER_FALLBACK_ENABLED=false` to return `503` instead. |
| Any unhandled exception | Caught by the global filter and returned as a JSON error envelope. |

Totals (`total_grid_kwh`, `total_cost_bdt`, `peak_grid_kwh`) are always
recomputed from `hourly_plan`, so the headline numbers can never disagree with
the schedule. If the optimizer reported different totals, the discrepancy is
logged.

### The local fallback dispatcher

`LocalOptimizer` is not a second optimizer competing with the Python service —
it is the answer to "the optimizer is down, mid-judging". It is deterministic
and directive-respecting:

1. Solar serves demand first; surplus solar charges the battery.
2. The battery's usable energy is allocated to the most expensive hours, and a
   price tie is **water-filled** so equally priced peak hours come down evenly
   instead of the pack emptying into whichever hour came first.
3. Grid charging happens only where it pays for itself after charging losses,
   never in an hour that also discharges, and never above the import peak the
   plan already has — arbitrage may fill a valley, never build a taller peak.
4. Two rounds run: the first plans on solar alone, the second re-allocates with
   the energy arbitrage actually bought.

`no_charge_window`, `no_discharge_window`, `minimum_battery_reserve` (including
reserves required later in the day) and `max_grid_window` are hard constraints.
A grid cap that is physically impossible is reported in `plan_summary` instead
of being silently ignored.

---

## Optimizer service contract

`POST {OPTIMIZER_URL}{OPTIMIZER_PATH}` (default `http://localhost:8000/solve`), served by the sibling `optimizer-service`:

```json
{
  "scenario_id": "bup-campus-day-1",
  "hours": [{ "hour": 8, "demand_kwh": 32, "solar_kwh": 10, "tariff_bdt_per_kwh": 6.2 }],
  "battery": {
    "capacity_kwh": 120,
    "initial_soc_kwh": 60,
    "max_charge_kwh": 30,
    "max_discharge_kwh": 30,
    "efficiency": 0.95,
    "min_reserve_kwh": 10
  },
  "directives": [
    {
      "note_index": 0,
      "directive_type": "solar_reduction",
      "structured_adjustment": { "hours": [13, 14], "factor": 0.2 }
    }
  ]
}
```

Only actionable directives are sent (`no_op` is dropped). Battery defaults are
resolved before sending: absent charge/discharge limits become the pack
capacity, `efficiency` defaults to `0.95`, `initial_soc_kwh` and
`min_reserve_kwh` default to `0`. `efficiency` applies on charging
(`stored = drawn * efficiency`); discharge is 1:1.

Expected response — `hourly_plan` is required, the totals are optional and
recomputed anyway:

```json
{
  "hourly_plan": [
    {
      "hour": 8,
      "demand_kwh": 32,
      "solar_kwh": 10,
      "solar_used_kwh": 10,
      "battery_charge_kwh": 0,
      "battery_discharge_kwh": 0,
      "battery_soc_kwh": 60,
      "grid_kwh": 22,
      "tariff_bdt_per_kwh": 6.2,
      "cost_bdt": 136.4
    }
  ],
  "total_grid_kwh": 22,
  "total_cost_bdt": 136.4,
  "peak_grid_kwh": 22,
  "plan_summary": "optional"
}
```

A `GET {OPTIMIZER_URL}/health` endpoint is used by `/health/details` if present.

---

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

> **Model note.** The challenge brief names `gemini-2.0-flash`. Google has
> retired it — the API answers `404 … no longer available` and points at
> `gemini-3.6-flash` (OpenRouter's `google/gemini-2.0-flash-001` is likewise
> gone, and `gemini-2.5-flash` is closed to new API keys).
>
> Measured on our key: the heavy flash tier returns `503 high demand` most of
> the time and takes 12-30s when it does answer, while `gemini-3.5-flash-lite`
> answers in ~2s at the same directive quality. The shipped setup is therefore
> **flash-lite on Gemini, `google/gemini-3.6-flash` on OpenRouter as the
> stronger fallback**. Both are environment-driven — if the organisers pin a
> model, set `GEMINI_MODEL` / `OPENROUTER_MODEL` and nothing else changes.
> Check what a key can reach, and how fast, with:
>
> ```bash
> curl -s -H "x-goog-api-key: $GEMINI_API_KEY" \
>   https://generativelanguage.googleapis.com/v1beta/models
> ```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `GEMINI_API_KEY` | — | Primary LLM provider key. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Gemini model id. |
| `OPENROUTER_API_KEY` | — | Fallback provider key. |
| `OPENROUTER_MODEL` | `google/gemini-3.6-flash` | Fallback model id. |
| `LLM_TIMEOUT_MS` | `30000` | Per-call timeout. |
| `LLM_MAX_RETRIES` | `2` | Retries after the first attempt, per provider. `.env` ships `1` so an overloaded Gemini fails over to OpenRouter quickly. |
| `LLM_PROVIDER_ORDER` | `gemini,openrouter` | Order providers are tried in. Swap it to make OpenRouter primary without a code change. |
| `LLM_TEMPERATURE` | `0` | Kept at 0 for reproducible interpretations. |
| `LLM_MAX_OUTPUT_TOKENS` | `4096` | Answer cap. Required by OpenRouter, which otherwise reserves the model's full context window and returns 402 on a low-credit account. |
| `OPTIMIZER_URL` | `http://localhost:8000` | Python optimizer base URL. |
| `OPTIMIZER_PATH` | `/solve` | Optimizer route. |
| `OPTIMIZER_TIMEOUT_MS` | `20000` | Per-call timeout. |
| `OPTIMIZER_MAX_RETRIES` | `2` | Retries after the first attempt. |
| `OPTIMIZER_FALLBACK_ENABLED` | `true` | Use the local dispatcher when the optimizer is unreachable. |

---

## Running

```bash
npm install
npm run start:dev        # watch mode on http://localhost:3000
npm run build && npm run start:prod
```

Smoke test:

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/optimize-energy \
  -H 'Content-Type: application/json' \
  -d @examples/sample-request.json
```

### Docker

```bash
docker build -t gridwise-api .
docker run --rm -p 3000:3000 --env-file .env gridwise-api
```

With the optimizer alongside it:

```bash
docker compose up --build
```

`docker-compose.yml` expects the Python optimizer's Dockerfile in `../optimizer`;
adjust the `build.context` if your service lives elsewhere.

### Tests

```bash
npm test          # unit: JSON repair, directive validation, fallback dispatcher
npm run test:e2e  # e2e: /health and /optimize-energy with a stubbed LLM
npm run lint
```

The e2e suite deliberately points at an unreachable optimizer so the fallback
path is covered, and includes a case where every LLM provider is down.

---

## Project layout

```
src/
├── main.ts                      bootstrap, global pipes/filters
├── app.module.ts                composition root
├── health/                      GET /health
├── optimize/                    POST /optimize-energy, orchestration
├── llm/                         Gemini + OpenRouter clients, prompt, JSON repair
├── validator/                   directive validation (LLM trust boundary)
├── optimizer/                   axios client + local fallback dispatcher
├── schemas/                     DTOs, directive contract, optimizer contract
└── common/                      retry, HTTP errors, filter, interceptor, middleware
```
