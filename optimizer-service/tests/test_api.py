"""HTTP surface: contract, error handling and the NestJS integration shape."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

from .conftest import battery, full_day, hour, scenario

client = TestClient(app, raise_server_exceptions=False)


class TestHealth:
    def test_health_is_ok(self):
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    def test_health_details_reports_configuration(self):
        body = client.get("/health/details").json()
        assert body["solver_backend"]
        assert body["solar_factor_semantics"] in {"loss", "retain"}


class TestSolve:
    def test_returns_the_documented_contract(self):
        response = client.post("/solve", json=scenario())
        assert response.status_code == 200

        body = response.json()
        for field in (
            "hourly_plan",
            "total_grid_kwh",
            "total_cost_bdt",
            "peak_grid_kwh",
        ):
            assert field in body

        assert len(body["hourly_plan"]) == 24
        assert body["status"] == "optimal"
        assert body["validation"]["passed"] is True
        assert body["plan_summary"]

    def test_every_row_carries_the_declared_variables(self):
        row = client.post("/solve", json=scenario()).json()["hourly_plan"][0]
        for field in (
            "grid_kwh",
            "solar_used_kwh",
            "battery_charge_kwh",
            "battery_discharge_kwh",
            "battery_energy_after_kwh",
            "battery_soc_kwh",
            "cost_bdt",
        ):
            assert field in row

    def test_totals_match_the_schedule(self):
        body = client.post("/solve", json=scenario()).json()
        plan = body["hourly_plan"]
        assert body["total_grid_kwh"] == pytest.approx(
            sum(row["grid_kwh"] for row in plan), abs=1e-6
        )
        assert body["total_cost_bdt"] == pytest.approx(
            sum(row["cost_bdt"] for row in plan), abs=1e-6
        )
        assert body["peak_grid_kwh"] == pytest.approx(
            max(row["grid_kwh"] for row in plan), abs=1e-6
        )

    def test_optimize_alias_matches_solve(self):
        payload = scenario()
        assert (
            client.post("/optimize", json=payload).json()["total_cost_bdt"]
            == client.post("/solve", json=payload).json()["total_cost_bdt"]
        )

    def test_accepts_the_nestjs_payload_spelling(self):
        payload = {
            "scenario_id": "from-nest",
            "hours": [
                {
                    "hour": index,
                    "demand_kwh": 40,
                    "solar_kwh": 0,
                    "tariff_bdt_per_kwh": 7,
                }
                for index in range(24)
            ],
            "battery": {
                "capacity_kwh": 100,
                "initial_soc_kwh": 50,
                "max_charge_kwh": 20,
                "max_discharge_kwh": 20,
                "efficiency": 0.95,
                "min_reserve_kwh": 0,
            },
            "directives": [
                {
                    "note_index": 0,
                    "directive_type": "solar_reduction",
                    "structured_adjustment": {"hours": [13, 14], "factor": 0.2},
                }
            ],
        }
        response = client.post("/solve", json=payload)
        assert response.status_code == 200
        assert response.json()["scenario_id"] == "from-nest"

    def test_directive_warnings_are_surfaced(self):
        payload = scenario(
            directives=[
                {
                    "directive_type": "max_grid_window",
                    "structured_adjustment": {"hours": [10], "max_kwh": "lots"},
                }
            ]
        )
        body = client.post("/solve", json=payload).json()
        assert any("max_kwh" in warning for warning in body["warnings"])

    def test_an_impossible_cap_is_relaxed_and_reported(self):
        payload = scenario(
            directives=[
                {
                    "directive_type": "max_grid_window",
                    "structured_adjustment": {
                        "hours": list(range(24)),
                        "max_kwh": 5,
                    },
                }
            ]
        )
        body = client.post("/solve", json=payload).json()
        assert body["status"] == "relaxed"
        assert body["relaxations"]
        assert "Relaxed to stay feasible" in body["plan_summary"]


class TestErrorHandling:
    def test_malformed_body_is_422(self):
        response = client.post("/solve", json={"scenario_id": "broken"})
        assert response.status_code == 422
        assert response.json()["details"]

    def test_out_of_range_hour_is_422(self):
        payload = scenario(hours=[hour(99)])
        assert client.post("/solve", json=payload).status_code == 422

    def test_unsolvable_scenario_is_400(self):
        rows = full_day()
        rows[3] = hour(2)
        response = client.post("/solve", json=scenario(hours=rows))
        assert response.status_code == 400
        assert any("duplicate" in detail for detail in response.json()["details"])

    def test_infeasible_without_relaxation_is_422(self):
        payload = scenario(
            options={"allow_relaxation": False},
            directives=[
                {
                    "directive_type": "max_grid_window",
                    "structured_adjustment": {
                        "hours": list(range(24)),
                        "max_kwh": 5,
                    },
                }
            ],
        )
        response = client.post("/solve", json=payload)
        assert response.status_code == 422
        assert response.json()["details"]

    def test_unknown_directive_type_is_422(self):
        payload = scenario(
            directives=[
                {"directive_type": "shutdown_campus", "structured_adjustment": {}}
            ]
        )
        assert client.post("/solve", json=payload).status_code == 422

    def test_empty_hours_is_422(self):
        assert client.post("/solve", json=scenario(hours=[])).status_code == 422

    def test_negative_demand_is_422(self):
        payload = scenario(hours=[hour(0, demand=-5)])
        assert client.post("/solve", json=payload).status_code == 422
