"""FastAPI entry point for the GridWise optimizer service.

`POST /solve` is the documented route; `/optimize` is an alias so the NestJS
client works whichever path it is configured with.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .config import settings
from .schemas import ErrorResponse, SolveRequest, SolveResponse
from .solver import InfeasibleError, SolverError, solve
from .validator import (
    InvalidInputError,
    prepare_constraints,
    validate_request,
    validate_solution,
)

# Spelled out rather than taken from `fastapi.status`: Starlette renamed the
# 422 constant and importing the old name emits a deprecation warning.
HTTP_BAD_REQUEST = 400
HTTP_UNPROCESSABLE = 422
HTTP_SERVER_ERROR = 500

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)-7s [%(name)s] %(message)s",
)
logger = logging.getLogger("gridwise.optimizer")

app = FastAPI(
    title="GridWise Optimizer Service",
    description=(
        "Mathematical optimization for the BUP CSE FEST 2026 GridWise challenge. "
        "Consumes validated directives from the NestJS API and returns a cost "
        "minimal 24 hour dispatch schedule."
    ),
    version="1.0.0",
)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe used by the NestJS service and the Docker HEALTHCHECK."""
    return {"status": "ok"}


@app.get("/health/details")
def health_details() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "gridwise-optimizer",
        "solver_backend": settings.solver_backend,
        "solar_factor_semantics": settings.solar_factor_semantics,
        "require_full_day": settings.require_full_day,
    }


@app.post("/solve", response_model=SolveResponse)
@app.post("/optimize", response_model=SolveResponse, include_in_schema=False)
def solve_scenario(request: SolveRequest) -> SolveResponse:
    """Validates, solves and then re-verifies a campus dispatch scenario."""
    started = time.perf_counter()

    warnings = validate_request(request, settings)
    prepared = prepare_constraints(request, settings)
    warnings.extend(prepared.warnings)

    outcome = solve(request, prepared, settings)

    report = validate_solution(request, prepared, outcome.plan, outcome.relaxations)
    if not report.passed:
        # The solver claimed success but the answer does not hold up. Say so
        # loudly rather than shipping a schedule nobody can trust.
        logger.error(
            "scenario=%s solution failed verification: %s",
            request.scenario_id,
            "; ".join(report.violations),
        )

    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    logger.info(
        "scenario=%s hours=%d directives=%d grid=%.3fkWh cost=%.2fBDT peak=%.3fkWh "
        "status=%s in %.1fms",
        request.scenario_id,
        len(outcome.plan),
        len(request.directives),
        outcome.total_grid_kwh,
        outcome.total_cost_bdt,
        outcome.peak_grid_kwh,
        "relaxed" if outcome.relaxations else "optimal",
        elapsed_ms,
    )

    return SolveResponse(
        scenario_id=request.scenario_id,
        hourly_plan=outcome.plan,
        total_grid_kwh=outcome.total_grid_kwh,
        total_cost_bdt=outcome.total_cost_bdt,
        peak_grid_kwh=outcome.peak_grid_kwh,
        status="relaxed" if outcome.relaxations else "optimal",
        relaxations=outcome.relaxations,
        warnings=warnings,
        validation=report,
        plan_summary=_summarize(request, outcome, report),
        solver=f"ortools-{outcome.backend.lower()}",
        solve_time_ms=outcome.solve_time_ms,
    )


def _summarize(request, outcome, report) -> str:
    applied = sum(
        1 for directive in request.directives if directive.directive_type != "no_op"
    )
    peak_hour = max(outcome.plan, key=lambda row: row.grid_kwh, default=None)
    solar_used = sum(row.solar_used_kwh for row in outcome.plan)
    discharged = sum(row.battery_discharge_kwh for row in outcome.plan)
    charged = sum(row.battery_charge_kwh for row in outcome.plan)

    parts = [
        f"Cost optimal dispatch over {len(outcome.plan)} hour(s) honouring "
        f"{applied} directive(s).",
        f"Grid import {outcome.total_grid_kwh:.3f} kWh for BDT "
        f"{outcome.total_cost_bdt:.2f}, peaking at {outcome.peak_grid_kwh:.3f} kWh"
        + (f" in hour {peak_hour.hour}." if peak_hour else "."),
        f"Solar served {solar_used:.3f} kWh of demand; the battery absorbed "
        f"{charged:.3f} kWh and delivered {discharged:.3f} kWh.",
    ]
    if outcome.relaxations:
        parts.append("Relaxed to stay feasible: " + "; ".join(outcome.relaxations) + ".")
    if not report.passed:
        parts.append(
            "WARNING: the schedule failed post-solve verification: "
            + "; ".join(report.violations)
        )
    return " ".join(parts)


def _error(status_code: int, error: str, message: str, details: list[str]):
    return JSONResponse(
        status_code=status_code,
        content=ErrorResponse(
            status_code=status_code, error=error, message=message, details=details
        ).model_dump(),
    )


@app.exception_handler(RequestValidationError)
def handle_schema_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    details = [
        f"{'.'.join(str(part) for part in err['loc'][1:])}: {err['msg']}"
        for err in exc.errors()
    ]
    logger.warning("rejected malformed payload: %s", details)
    return _error(
        HTTP_UNPROCESSABLE,
        "Unprocessable Entity",
        "request body does not match the solver contract",
        details,
    )


@app.exception_handler(InvalidInputError)
def handle_invalid_input(_: Request, exc: InvalidInputError) -> JSONResponse:
    logger.warning("rejected scenario: %s %s", exc.message, exc.details)
    return _error(HTTP_BAD_REQUEST, "Bad Request", exc.message, exc.details)


@app.exception_handler(InfeasibleError)
def handle_infeasible(_: Request, exc: InfeasibleError) -> JSONResponse:
    logger.error("infeasible scenario: %s", exc.details)
    return _error(
        HTTP_UNPROCESSABLE, "Unprocessable Entity", exc.message, exc.details
    )


@app.exception_handler(SolverError)
def handle_solver_error(_: Request, exc: SolverError) -> JSONResponse:
    logger.exception("solver failure")
    return _error(HTTP_SERVER_ERROR, "Internal Server Error", str(exc), [])


@app.exception_handler(Exception)
def handle_unexpected(_: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled error")
    return _error(
        HTTP_SERVER_ERROR, "Internal Server Error", f"{type(exc).__name__}: {exc}", []
    )
