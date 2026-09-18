"""Solver behaviour: optimality, directive compliance and infeasibility."""

from __future__ import annotations

import pytest

from app.config import Settings
from app.solver import InfeasibleError, solve
from app.validator import prepare_constraints, validate_solution

from .conftest import build, full_day, hour


def run(request):
    prepared = prepare_constraints(request)
    outcome = solve(request, prepared)
    report = validate_solution(request, prepared, outcome.plan, outcome.relaxations)
    assert report.passed, report.violations
    return outcome


def row_at(outcome, index: int):
    return next(row for row in outcome.plan if row.hour == index)


class TestEnergyPhysics:
    def test_energy_balance_holds_every_hour(self):
        outcome = run(build())
        for row in outcome.plan:
            supply = row.grid_kwh + row.solar_used_kwh + row.battery_discharge_kwh
            assert supply == pytest.approx(
                row.demand_kwh + row.battery_charge_kwh, abs=1e-6
            )

    def test_battery_returns_to_its_starting_energy(self):
        request = build()
        outcome = run(request)
        assert outcome.plan[-1].battery_energy_after_kwh == pytest.approx(
            request.battery.initial_soc_kwh, abs=1e-6
        )

    def test_stored_energy_stays_within_reserve_and_capacity(self):
        request = build()
        outcome = run(request)
        for row in outcome.plan:
            assert row.battery_energy_after_kwh >= 10.0 - 1e-6
            assert row.battery_energy_after_kwh <= 100.0 + 1e-6

    def test_charging_losses_are_accounted_for(self):
        request = build(battery={"capacity_kwh": 100.0, "initial_soc_kwh": 0.0,
                                 "max_charge_kwh": 10.0, "max_discharge_kwh": 10.0,
                                 "efficiency": 0.5, "min_reserve_kwh": 0.0})
        outcome = run(request)
        first = outcome.plan[0]
        assert first.battery_energy_after_kwh == pytest.approx(
            first.battery_charge_kwh * 0.5 - first.battery_discharge_kwh, abs=1e-6
        )

    def test_surplus_solar_is_curtailed_not_forced_into_demand(self):
        # 80 kWh of solar against 10 kWh of demand and a full, idle battery.
        rows = [hour(index, demand=10.0, solar=80.0) for index in range(24)]
        request = build(
            hours=rows,
            battery={"capacity_kwh": 20.0, "initial_soc_kwh": 20.0,
                     "max_charge_kwh": 0.0, "max_discharge_kwh": 0.0,
                     "efficiency": 1.0, "min_reserve_kwh": 0.0},
        )
        outcome = run(request)
        assert outcome.total_grid_kwh == pytest.approx(0.0, abs=1e-6)
        assert outcome.plan[0].solar_curtailed_kwh == pytest.approx(70.0, abs=1e-6)


class TestObjective:
    def test_buys_cheap_energy_to_cover_the_expensive_evening(self):
        outcome = run(build())
        evening = [row_at(outcome, index) for index in (18, 19, 20)]
        assert sum(row.battery_discharge_kwh for row in evening) > 0
        # Charging must have happened in cheaper hours.
        cheap_charge = sum(
            row.battery_charge_kwh for row in outcome.plan if row.hour < 18
        )
        assert cheap_charge > 0

    def test_beats_the_naive_grid_only_cost(self):
        request = build()
        outcome = run(request)
        naive = sum(
            max(0.0, item.demand_kwh - item.solar_kwh) * item.tariff_bdt_per_kwh
            for item in request.hours
        )
        assert outcome.total_cost_bdt < naive

    def test_peak_penalty_lowers_the_peak_when_asked(self):
        baseline = run(build())
        shaved = run(build(options={"peak_penalty_bdt_per_kwh": 50.0}))
        assert shaved.peak_grid_kwh < baseline.peak_grid_kwh
        assert shaved.total_cost_bdt >= baseline.total_cost_bdt - 1e-6


class TestDirectives:
    def test_solar_reduction_scales_available_solar(self):
        request = build(
            directives=[
                {
                    "directive_type": "solar_reduction",
                    "structured_adjustment": {"hours": [12, 13], "factor": 0.25},
                }
            ]
        )
        outcome = run(request)
        assert row_at(outcome, 12).solar_kwh == pytest.approx(15.0)
        assert row_at(outcome, 11).solar_kwh == pytest.approx(20.0)

    def test_solar_reduction_can_be_read_as_retained_share(self):
        request = build(
            directives=[
                {
                    "directive_type": "solar_reduction",
                    "structured_adjustment": {"hours": [12], "factor": 0.25},
                }
            ]
        )
        retain = Settings(
            solar_factor_semantics="retain",
            require_full_day=False,
            solver_backend="GLOP",
            solver_time_limit_ms=10_000,
            log_level="INFO",
        )
        prepared = prepare_constraints(request, retain)
        assert next(h for h in prepared.hours if h.hour == 12).solar_kwh == 5.0

    def test_no_charge_window_is_respected(self):
        outcome = run(
            build(
                directives=[
                    {
                        "directive_type": "no_charge_window",
                        "structured_adjustment": {"hours": [10, 11, 12]},
                    }
                ]
            )
        )
        for index in (10, 11, 12):
            assert row_at(outcome, index).battery_charge_kwh == 0.0

    def test_no_discharge_window_is_respected(self):
        outcome = run(
            build(
                directives=[
                    {
                        "directive_type": "no_discharge_window",
                        "structured_adjustment": {"hours": [18, 19]},
                    }
                ]
            )
        )
        for index in (18, 19):
            assert row_at(outcome, index).battery_discharge_kwh == 0.0

    def test_max_grid_window_caps_import(self):
        outcome = run(
            build(
                directives=[
                    {
                        "directive_type": "max_grid_window",
                        "structured_adjustment": {"hours": [18, 19, 20], "max_kwh": 30.0},
                    }
                ]
            )
        )
        for index in (18, 19, 20):
            assert row_at(outcome, index).grid_kwh <= 30.0 + 1e-6

    def test_minimum_battery_reserve_holds_the_floor(self):
        outcome = run(
            build(
                directives=[
                    {
                        "directive_type": "minimum_battery_reserve",
                        "structured_adjustment": {"reserve_kwh": 35.0},
                    }
                ]
            )
        )
        for row in outcome.plan:
            assert row.battery_energy_after_kwh >= 35.0 - 1e-6

    def test_reserve_can_apply_to_a_window_only(self):
        outcome = run(
            build(
                directives=[
                    {
                        "directive_type": "minimum_battery_reserve",
                        "structured_adjustment": {"reserve_kwh": 60.0, "hours": [22, 23]},
                    }
                ]
            )
        )
        assert row_at(outcome, 22).battery_energy_after_kwh >= 60.0 - 1e-6
        assert row_at(outcome, 23).battery_energy_after_kwh >= 60.0 - 1e-6

    def test_no_op_changes_nothing(self):
        plain = run(build())
        with_noop = run(
            build(
                directives=[
                    {"directive_type": "no_op", "structured_adjustment": {}}
                ]
            )
        )
        assert with_noop.total_cost_bdt == pytest.approx(plain.total_cost_bdt)

    def test_directives_combine(self):
        outcome = run(
            build(
                directives=[
                    {
                        "directive_type": "solar_reduction",
                        "structured_adjustment": {"hours": [12], "factor": 0.5},
                    },
                    {
                        "directive_type": "no_charge_window",
                        "structured_adjustment": {"hours": [12]},
                    },
                    {
                        "directive_type": "max_grid_window",
                        "structured_adjustment": {"hours": [19], "max_kwh": 40.0},
                    },
                    {
                        "directive_type": "minimum_battery_reserve",
                        "structured_adjustment": {"reserve_kwh": 20.0},
                    },
                ]
            )
        )
        assert row_at(outcome, 12).solar_kwh == pytest.approx(10.0)
        assert row_at(outcome, 12).battery_charge_kwh == 0.0
        assert row_at(outcome, 19).grid_kwh <= 40.0 + 1e-6
        assert min(row.battery_energy_after_kwh for row in outcome.plan) >= 20.0 - 1e-6


class TestInfeasibility:
    def _impossible_cap(self):
        # 50 kWh of demand, no solar, a 10 kWh cap and a pack that cannot
        # possibly cover the gap for a whole day.
        return build(
            directives=[
                {
                    "directive_type": "max_grid_window",
                    "structured_adjustment": {
                        "hours": list(range(24)),
                        "max_kwh": 10.0,
                    },
                }
            ]
        )

    def test_relaxes_and_reports_instead_of_failing(self):
        request = self._impossible_cap()
        prepared = prepare_constraints(request)
        outcome = solve(request, prepared)

        assert outcome.relaxations, "expected the cap to be reported as relaxed"
        assert any("max_grid_window" in item for item in outcome.relaxations)
        assert len(outcome.plan) == 24

    def test_raises_when_relaxation_is_disabled(self):
        request = self._impossible_cap()
        request.options.allow_relaxation = False
        with pytest.raises(InfeasibleError) as error:
            solve(request, prepare_constraints(request))
        assert error.value.details

    def test_final_neutrality_can_be_turned_off(self):
        request = build(options={"enforce_final_neutrality": False})
        outcome = run(request)
        # Free to end the day emptier than it started, and cheaper for it.
        neutral = run(build())
        assert outcome.total_cost_bdt <= neutral.total_cost_bdt + 1e-6

    def test_reserve_above_reach_is_relaxed_not_crashed(self):
        request = build(
            battery={"capacity_kwh": 100.0, "initial_soc_kwh": 10.0,
                     "max_charge_kwh": 0.0, "max_discharge_kwh": 25.0,
                     "efficiency": 0.95, "min_reserve_kwh": 0.0},
            directives=[
                {
                    "directive_type": "minimum_battery_reserve",
                    "structured_adjustment": {"reserve_kwh": 80.0},
                }
            ],
        )
        outcome = solve(request, prepare_constraints(request))
        assert any("minimum_battery_reserve" in item for item in outcome.relaxations)
