"""Shared scenario builders for the optimizer test suite."""

from __future__ import annotations

from typing import Any

import pytest

from app.schemas import SolveRequest

CHEAP = 6.0
EXPENSIVE = 14.0


def hour(
    index: int,
    demand: float = 50.0,
    solar: float = 0.0,
    tariff: float = CHEAP,
) -> dict[str, Any]:
    return {
        "hour": index,
        "demand_kwh": demand,
        "solar_kwh": solar,
        "tariff_bdt_per_kwh": tariff,
    }


def full_day(
    demand: float = 50.0,
    solar_hours: tuple[int, int] = (9, 15),
    solar: float = 20.0,
    peak_hours: tuple[int, int] = (18, 20),
) -> list[dict[str, Any]]:
    """A plain 24 hour day: solar around midday, expensive evening."""
    rows = []
    for index in range(24):
        sun = solar if solar_hours[0] <= index <= solar_hours[1] else 0.0
        tariff = EXPENSIVE if peak_hours[0] <= index <= peak_hours[1] else CHEAP
        rows.append(hour(index, demand=demand, solar=sun, tariff=tariff))
    return rows


def battery(**overrides: Any) -> dict[str, Any]:
    base = {
        "capacity_kwh": 100.0,
        "initial_soc_kwh": 40.0,
        "max_charge_kwh": 25.0,
        "max_discharge_kwh": 25.0,
        "efficiency": 0.95,
        "min_reserve_kwh": 10.0,
    }
    base.update(overrides)
    return base


def scenario(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "scenario_id": "test-scenario",
        "hours": full_day(),
        "battery": battery(),
        "directives": [],
    }
    payload.update(overrides)
    return payload


def build(**overrides: Any) -> SolveRequest:
    return SolveRequest.model_validate(scenario(**overrides))


@pytest.fixture
def request_factory():
    return build
