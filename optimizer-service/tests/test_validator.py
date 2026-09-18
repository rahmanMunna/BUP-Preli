"""Input validation, directive normalisation and post-solve verification."""

from __future__ import annotations

import pytest

from app.config import Settings
from app.schemas import HourlyPlanRow
from app.solver import solve
from app.validator import (
    InvalidInputError,
    prepare_constraints,
    validate_request,
    validate_solution,
)

from .conftest import build, full_day, hour


def strict_settings() -> Settings:
    return Settings(
        solar_factor_semantics="loss",
        require_full_day=True,
        solver_backend="GLOP",
        solver_time_limit_ms=10_000,
        log_level="INFO",
    )


class TestRequestValidation:
    def test_accepts_a_plain_day(self):
        assert validate_request(build()) == []

    def test_rejects_duplicate_hours(self):
        rows = full_day()
        rows[5] = hour(4)
        with pytest.raises(InvalidInputError) as error:
            validate_request(build(hours=rows))
        assert any("duplicate" in detail for detail in error.value.details)

    def test_warns_about_a_partial_horizon_by_default(self):
        warnings = validate_request(build(hours=full_day()[:12]))
        assert any("12 hour" in warning for warning in warnings)

    def test_rejects_a_partial_horizon_when_a_full_day_is_required(self):
        with pytest.raises(InvalidInputError) as error:
            validate_request(build(hours=full_day()[:12]), strict_settings())
        assert any("24" in detail for detail in error.value.details)

    def test_rejects_a_reserve_larger_than_the_pack(self):
        with pytest.raises(InvalidInputError):
            validate_request(
                build(battery={"capacity_kwh": 50.0, "min_reserve_kwh": 80.0})
            )

    def test_rejects_a_charge_level_above_capacity(self):
        with pytest.raises(InvalidInputError):
            validate_request(
                build(battery={"capacity_kwh": 50.0, "initial_soc_kwh": 90.0})
            )

    def test_warns_when_the_pack_starts_below_its_reserve(self):
        warnings = validate_request(
            build(
                battery={
                    "capacity_kwh": 100.0,
                    "initial_soc_kwh": 5.0,
                    "min_reserve_kwh": 20.0,
                }
            )
        )
        assert any("below its own minimum reserve" in item for item in warnings)

    def test_hour_out_of_range_is_caught_by_the_schema(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            build(hours=[hour(24)])


class TestDirectiveNormalisation:
    def test_percentage_factor_is_read_as_a_fraction(self):
        prepared = prepare_constraints(
            build(
                directives=[
                    {
                        "directive_type": "solar_reduction",
                        "structured_adjustment": {"hours": [12], "factor": 25},
                    }
                ]
            )
        )
        assert next(h for h in prepared.hours if h.hour == 12).solar_kwh == 15.0

    def test_percentage_reserve_is_converted_with_capacity(self):
        prepared = prepare_constraints(
            build(
                directives=[
                    {
                        "directive_type": "minimum_battery_reserve",
                        "structured_adjustment": {"reserve_percent": 30},
                    }
                ]
            )
        )
        assert all(h.reserve_kwh == pytest.approx(30.0) for h in prepared.hours)

    def test_hours_outside_the_horizon_are_dropped_with_a_warning(self):
        prepared = prepare_constraints(
            build(
                hours=full_day()[:12],
                directives=[
                    {
                        "directive_type": "no_charge_window",
                        "structured_adjustment": {"hours": [11, 20]},
                    }
                ],
            )
        )
        assert any("outside the scenario horizon" in w for w in prepared.warnings)
        assert next(h for h in prepared.hours if h.hour == 11).charge_blocked

    def test_a_directive_without_hours_covers_the_whole_horizon(self):
        prepared = prepare_constraints(
            build(
                directives=[
                    {
                        "directive_type": "no_discharge_window",
                        "structured_adjustment": {},
                    }
                ]
            )
        )
        assert all(h.discharge_blocked for h in prepared.hours)

    def test_unusable_values_are_ignored_and_reported(self):
        prepared = prepare_constraints(
            build(
                directives=[
                    {
                        "directive_type": "max_grid_window",
                        "structured_adjustment": {
                            "hours": [10],
                            "max_kwh": "as low as possible",
                        },
                    }
                ]
            )
        )
        assert next(h for h in prepared.hours if h.hour == 10).grid_cap_kwh is None
        assert any("max_kwh" in warning for warning in prepared.warnings)

    def test_the_strictest_of_overlapping_directives_wins(self):
        prepared = prepare_constraints(
            build(
                directives=[
                    {
                        "directive_type": "max_grid_window",
                        "structured_adjustment": {"hours": [19], "max_kwh": 40},
                    },
                    {
                        "directive_type": "max_grid_window",
                        "structured_adjustment": {"hours": [19], "max_kwh": 25},
                    },
                    {
                        "directive_type": "solar_reduction",
                        "structured_adjustment": {"hours": [12], "factor": 0.2},
                    },
                    {
                        "directive_type": "solar_reduction",
                        "structured_adjustment": {"hours": [12], "factor": 0.6},
                    },
                ]
            )
        )
        assert next(h for h in prepared.hours if h.hour == 19).grid_cap_kwh == 25.0
        assert next(h for h in prepared.hours if h.hour == 12).solar_kwh == 8.0


class TestSolutionVerification:
    def test_a_genuine_solution_passes(self):
        request = build()
        prepared = prepare_constraints(request)
        outcome = solve(request, prepared)
        report = validate_solution(request, prepared, outcome.plan, [])
        assert report.passed
        assert report.checks

    def test_a_tampered_energy_balance_is_caught(self):
        request = build()
        prepared = prepare_constraints(request)
        outcome = solve(request, prepared)
        tampered = list(outcome.plan)
        tampered[5] = tampered[5].model_copy(update={"grid_kwh": 0.0})

        report = validate_solution(request, prepared, tampered, [])
        assert not report.passed
        assert any("energy balance" in item for item in report.violations)

    def test_a_broken_final_neutrality_is_caught(self):
        request = build()
        prepared = prepare_constraints(request)
        outcome = solve(request, prepared)
        tampered = list(outcome.plan)
        tampered[-1] = tampered[-1].model_copy(
            update={"battery_energy_after_kwh": 5.0, "battery_soc_kwh": 5.0}
        )

        report = validate_solution(request, prepared, tampered, [])
        assert not report.passed

    def test_a_directive_violation_is_caught(self):
        request = build(
            directives=[
                {
                    "directive_type": "no_charge_window",
                    "structured_adjustment": {"hours": [3]},
                }
            ]
        )
        prepared = prepare_constraints(request)
        outcome = solve(request, prepared)
        tampered = [
            row.model_copy(update={"battery_charge_kwh": 5.0})
            if row.hour == 3
            else row
            for row in outcome.plan
        ]

        report = validate_solution(request, prepared, tampered, [])
        assert any("no_charge_window" in item for item in report.violations)

    def test_a_short_plan_is_caught(self):
        request = build()
        prepared = prepare_constraints(request)
        report = validate_solution(
            request,
            prepared,
            [
                HourlyPlanRow(
                    hour=0,
                    demand_kwh=1,
                    solar_kwh=0,
                    solar_used_kwh=0,
                    solar_curtailed_kwh=0,
                    battery_charge_kwh=0,
                    battery_discharge_kwh=0,
                    battery_energy_after_kwh=0,
                    battery_soc_kwh=0,
                    grid_kwh=1,
                    tariff_bdt_per_kwh=1,
                    cost_bdt=1,
                )
            ],
            [],
        )
        assert not report.passed
