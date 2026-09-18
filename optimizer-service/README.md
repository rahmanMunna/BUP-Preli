# GridWise Optimizer Service — BUP CSE FEST 2026

Mathematical optimization for **GridWise: Smart Campus Energy Optimization
Challenge**. Python + FastAPI + OR-Tools.

This service is not public. The NestJS API interprets the operator notes,
validates the resulting directives, and posts the scenario here; this service
returns the cost-minimal dispatch schedule.

```
NestJS API ──POST /solve──▶ optimizer-service
                              │ 1. validate the scenario
                              │ 2. directives ──▶ per-hour constraints
                              │ 3. build + solve the LP (OR-Tools GLOP)
                              │ 4. re-verify the answer against the physics
                              ◀── hourly_plan + totals
```

---

## Endpoints

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe (also the Docker HEALTHCHECK). |
| `GET` | `/health/details` | Reports solver backend and the active semantics. |
| `POST` | `/solve` | Optimize a scenario. |
| `POST` | `/optimize` | Alias of `/solve`, so either client config works. |
| `GET` | `/docs` | Interactive OpenAPI docs (FastAPI). |

### Request

```json
{
  "scenario_id": "bup-campus-day-1",
  "hours": [
    { "hour": 0, "demand_kwh": 32, "solar_kwh": 0, "tariff_bdt_per_kwh": 6.2 }
  ],
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
  ],
  "options": {
    "enforce_final_neutrality": true,
    "peak_penalty_bdt_per_kwh": 0,
    "allow_relaxation": true
  }
}
```

`options` is optional and defaults as shown. Absent battery rate limits default
to the pack capacity, `efficiency` to `0.95`, `initial_soc_kwh` and
`min_reserve_kwh` to `0`.

### Response

```json
{
  "scenario_id": "bup-campus-day-1",
  "hourly_plan": [
    {
      "hour": 18,
      "demand_kwh": 66,
      "solar_kwh": 0,
      "solar_used_kwh": 0,
      "solar_curtailed_kwh": 0,
      "battery_charge_kwh": 0,
      "battery_discharge_kwh": 30,
      "battery_energy_after_kwh": 90,
      "battery_soc_kwh": 90,
      "grid_kwh": 36,
      "tariff_bdt_per_kwh": 14.2,
      "cost_bdt": 511.2
    }
  ],
  "total_grid_kwh": 481.737,
  "total_cost_bdt": 4300.232,
  "peak_grid_kwh": 67.0,
  "status": "optimal",
  "relaxations": [],
  "warnings": [],
  "validation": { "passed": true, "checks": ["..."], "violations": [] },
  "plan_summary": "Cost optimal dispatch over 14 hour(s) honouring 5 directive(s). …",
  "solver": "ortools-glop",
  "solve_time_ms": 4.9
}
```

`battery_soc_kwh` duplicates `battery_energy_after_kwh` because that is the key
the NestJS response contract uses. Both are the stored energy at the **end** of
the hour.

---

## The model

Decision variables, per hour `h`:

| Variable | Meaning |
| --- | --- |
| `grid_kwh[h]` | energy imported from the utility |
| `solar_used_kwh[h]` | on-site solar actually consumed |
| `battery_charge[h]` | energy pushed into the pack |
| `battery_discharge[h]` | energy pulled out of the pack |
| `battery_energy_after_kwh[h]` | stored energy at the end of the hour |

Constraints:

```
grid + solar_used + discharge == demand + charge            # energy balance
energy_after == energy_before + charge * efficiency - discharge
reserve <= energy_after <= capacity
0 <= charge <= max_charge,   0 <= discharge <= max_discharge
0 <= solar_used <= available solar                          # surplus is curtailed
grid <= cap                                                 # max_grid_window
energy_after[last] == initial energy                        # final neutrality
```

Objective:

```
minimise SUM(grid_kwh[h] * tariff[h])
```

It is a pure **linear program**, solved with OR-Tools' GLOP. No integer
variables are needed to stop the battery charging and discharging in the same
hour: with `efficiency < 1` that round trip destroys energy, so a cost-minimal
solution never does it. (For a lossless pack the two cancel exactly, and the
extractor nets them out so the schedule reads cleanly.)

Charging is lossy (`stored = drawn × efficiency`); discharging is 1:1. This
matches the NestJS contract.

### Directives

| `directive_type` | `structured_adjustment` | Effect on the model |
| --- | --- | --- |
| `solar_reduction` | `{"hours":[13,14],"factor":0.2}` | Upper bound on `solar_used` becomes `solar × (1 - factor)`. |
| `minimum_battery_reserve` | `{"reserve_kwh":25}`, optional `"hours"` | Raises the lower bound on `battery_energy_after_kwh`. |
| `no_charge_window` | `{"hours":[11,12]}` | `charge == 0` in those hours. |
| `no_discharge_window` | `{"hours":[9,10]}` | `discharge == 0` in those hours. |
| `max_grid_window` | `{"hours":[18,19],"max_kwh":45}` | Upper bound on `grid_kwh` in each listed hour. |
| `no_op` | `{}` | Ignored. |

Overlapping directives take the strictest value. A directive without `"hours"`
applies to the whole horizon. `factor` accepts `0.2` or `20`; a reserve may
arrive as `reserve_percent`. Hours outside the horizon, non-numeric values and
unusable shapes are dropped and reported in `warnings` rather than failing the
request — the NestJS validator has already rejected the worst of it, and a
half-usable directive should not cost the campus its schedule.

> **`solar_reduction` semantics.** `factor` is read as the fraction **lost**,
> so 0.2 means "20% less solar" — this is what the NestJS prompt instructs the
> interpreter to produce, and the two services must agree. If the organisers
> define it as the fraction *retained*, set `SOLAR_FACTOR_SEMANTICS=retain`
> here and flip the wording in the NestJS prompt. This is the one piece of the
> contract that the challenge text leaves genuinely ambiguous.

---

## Validation

Input is checked before the solver runs (`400` if it cannot describe a real
day): duplicate hours, hours outside `0-23`, a reserve or starting charge above
capacity. A horizon that is not 24 hours is a warning by default, so a partial
scenario still gets solved; set `REQUIRE_FULL_DAY=true` to reject it instead.

The solved plan is then **re-verified independently of the solver**, because a
model built wrong will still report "optimal":

- energy balance in every hour,
- storage dynamics, capacity and reserve floors,
- charge and discharge rate limits,
- no charging or discharging inside a blocked window, grid caps respected,
- no negative flows,
- the battery ends the horizon at the energy it started with.

The result travels with the response in `validation`. A failed check is logged
as an error and reported in `plan_summary` rather than quietly shipped.

---

## Infeasible scenarios

Directives can contradict physics — a grid cap below demand with an empty
battery, or a reserve that cannot be reached inside a `no_charge_window`. The
service does not simply fail: it retries the solve giving up one constraint at
a time, cheapest concession first, and reports exactly what it gave up.

| Attempt | Relaxed |
| --- | --- |
| 1 | nothing — the honest model |
| 2 | final neutrality |
| 3 | + `max_grid_window` caps |
| 4 | + `minimum_battery_reserve` floors |

The response then carries `status: "relaxed"` and a human readable
`relaxations` list. Set `options.allow_relaxation = false` to get `422` with
the diagnosis instead.

Error responses share one envelope:

```json
{
  "status_code": 400,
  "error": "Bad Request",
  "message": "scenario is not solvable as described",
  "details": ["duplicate hour indexes: [4]"]
}
```

`422` for a malformed body or a genuinely infeasible scenario, `400` for a
scenario that fails validation, `500` for a solver failure.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | HTTP port. |
| `SOLAR_FACTOR_SEMANTICS` | `loss` | `loss` → `solar × (1 - factor)`; `retain` → `solar × factor`. |
| `REQUIRE_FULL_DAY` | `false` | Reject horizons that are not exactly 24 hours. |
| `SOLVER_BACKEND` | `GLOP` | OR-Tools backend name (`GLOP`, `CBC`, `SCIP`, …). |
| `SOLVER_TIME_LIMIT_MS` | `10000` | Per-solve time limit. |
| `LOG_LEVEL` | `INFO` | Python log level. |

`peak_grid_kwh` is reported but **not** minimized: the brief defines the
objective as cost only. If the judge also scores peak, send
`options.peak_penalty_bdt_per_kwh` (BDT per kWh of peak import) and the solver
will trade cost against peak.

---

## Running

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements-dev.txt

uvicorn app.main:app --reload --port 8000
```

Smoke test:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/solve \
  -H 'Content-Type: application/json' \
  -d @examples/sample-solve.json
```

### Docker

```bash
docker build -t gridwise-optimizer .
docker run --rm -p 8000:8000 gridwise-optimizer
```

Both services together, from `../backend`:

```bash
docker compose up --build
```

### Tests

```bash
pytest            # 56 tests: solver, validator, HTTP surface
```

The suite covers energy balance and storage dynamics, every directive type,
combined directives, curtailment, the relaxation ladder, tampered-plan
detection, and the HTTP error contract.

---

## Talking to the NestJS service

The NestJS API posts to `${OPTIMIZER_URL}${OPTIMIZER_PATH}`, which defaults to
`http://localhost:8000/solve`. It re-computes `total_grid_kwh`,
`total_cost_bdt` and `peak_grid_kwh` from `hourly_plan` on its side, so those
can never disagree between the two services, and it logs a warning if what we
report differs from what the schedule adds up to.

If this service is unreachable, the NestJS API falls back to its own heuristic
dispatcher and marks the plan `engine: local-fallback` — a judge still gets a
feasible schedule, just not an optimal one. Watch for that label when checking
that the two services are really talking: on `localhost`, an IPv6-only or
IPv4-only bind on either side is enough to send the request somewhere else.
