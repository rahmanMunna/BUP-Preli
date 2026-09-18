"""Request and response contracts for the GridWise optimizer service.

The NestJS API is the only client. It sends a scenario plus directives that it
has already validated against the GridWise catalogue; this service re-validates
everything anyway, because a solver that trusts its input produces confident
nonsense.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    NonNegativeFloat,
)

HOURS_IN_DAY = 24


class DirectiveType(StrEnum):
    """The only directives this solver knows how to apply."""

    SOLAR_REDUCTION = "solar_reduction"
    MINIMUM_BATTERY_RESERVE = "minimum_battery_reserve"
    NO_CHARGE_WINDOW = "no_charge_window"
    NO_DISCHARGE_WINDOW = "no_discharge_window"
    MAX_GRID_WINDOW = "max_grid_window"
    NO_OP = "no_op"


class HourInput(BaseModel):
    """One hour of the scenario horizon."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    hour: Annotated[int, Field(ge=0, le=23)] = Field(
        validation_alias=AliasChoices("hour", "hour_index", "h"),
    )
    demand_kwh: NonNegativeFloat = Field(
        validation_alias=AliasChoices("demand_kwh", "demand"),
    )
    solar_kwh: NonNegativeFloat = Field(
        default=0.0,
        validation_alias=AliasChoices("solar_kwh", "solar"),
    )
    tariff_bdt_per_kwh: NonNegativeFloat = Field(
        validation_alias=AliasChoices("tariff_bdt_per_kwh", "tariff", "price"),
    )


class BatteryInput(BaseModel):
    """Storage parameters. Charging is lossy, discharging is 1:1."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    capacity_kwh: NonNegativeFloat = Field(
        validation_alias=AliasChoices("capacity_kwh", "capacity"),
    )
    initial_soc_kwh: NonNegativeFloat = Field(
        default=0.0,
        validation_alias=AliasChoices(
            "initial_soc_kwh", "initial_energy_kwh", "initial_soc", "soc_kwh"
        ),
    )
    max_charge_kwh: NonNegativeFloat | None = Field(
        default=None,
        validation_alias=AliasChoices("max_charge_kwh", "max_charge_kw"),
    )
    max_discharge_kwh: NonNegativeFloat | None = Field(
        default=None,
        validation_alias=AliasChoices("max_discharge_kwh", "max_discharge_kw"),
    )
    efficiency: Annotated[float, Field(gt=0.0, le=1.0)] = Field(
        default=0.95,
        validation_alias=AliasChoices("efficiency", "round_trip_efficiency"),
    )
    min_reserve_kwh: NonNegativeFloat = Field(
        default=0.0,
        validation_alias=AliasChoices("min_reserve_kwh", "min_reserve", "min_soc_kwh"),
    )

    @property
    def charge_limit(self) -> float:
        """Absent rate limits mean the pack size is the only limit."""
        return self.capacity_kwh if self.max_charge_kwh is None else self.max_charge_kwh

    @property
    def discharge_limit(self) -> float:
        return (
            self.capacity_kwh
            if self.max_discharge_kwh is None
            else self.max_discharge_kwh
        )


class Directive(BaseModel):
    """A validated directive as produced by the NestJS interpreter."""

    model_config = ConfigDict(extra="ignore")

    note_index: int | None = None
    directive_type: DirectiveType
    structured_adjustment: dict[str, Any] = Field(default_factory=dict)


class SolveOptions(BaseModel):
    """Knobs the caller may set per request; the defaults match the brief."""

    model_config = ConfigDict(extra="ignore")

    enforce_final_neutrality: bool = True
    """Battery must end the horizon at the energy it started with."""

    peak_penalty_bdt_per_kwh: NonNegativeFloat = 0.0
    """Optional cost per kWh of peak import, added to the objective. 0 = pure cost."""

    allow_relaxation: bool = True
    """On infeasibility, relax soft constraints and report it instead of failing."""


class SolveRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    scenario_id: str = Field(
        default="",
        validation_alias=AliasChoices("scenario_id", "scenarioId", "id"),
    )
    hours: list[HourInput] = Field(
        validation_alias=AliasChoices("hours", "hourly", "timeseries"),
        min_length=1,
        max_length=HOURS_IN_DAY,
    )
    battery: BatteryInput
    directives: list[Directive] = Field(default_factory=list, max_length=100)
    options: SolveOptions = Field(default_factory=SolveOptions)


class HourlyPlanRow(BaseModel):
    """One scheduled hour. Values are kWh unless the name says otherwise."""

    hour: int
    demand_kwh: float
    solar_kwh: float
    """Solar available after `solar_reduction` was applied."""
    solar_used_kwh: float
    solar_curtailed_kwh: float
    battery_charge_kwh: float
    battery_discharge_kwh: float
    battery_energy_after_kwh: float
    battery_soc_kwh: float
    """Alias of `battery_energy_after_kwh`, for the NestJS response contract."""
    grid_kwh: float
    tariff_bdt_per_kwh: float
    cost_bdt: float


class ValidationReport(BaseModel):
    """Result of re-checking the solved plan against the physics and directives."""

    passed: bool
    checks: list[str] = Field(default_factory=list)
    violations: list[str] = Field(default_factory=list)


class SolveResponse(BaseModel):
    scenario_id: str
    hourly_plan: list[HourlyPlanRow]
    total_grid_kwh: float
    total_cost_bdt: float
    peak_grid_kwh: float
    status: Literal["optimal", "relaxed"] = "optimal"
    relaxations: list[str] = Field(default_factory=list)
    """Constraints that had to be softened to reach a feasible plan."""
    warnings: list[str] = Field(default_factory=list)
    validation: ValidationReport
    plan_summary: str = ""
    solver: str = "ortools-glop"
    solve_time_ms: float = 0.0


class ErrorResponse(BaseModel):
    """Error envelope; mirrors the NestJS service so logs read the same."""

    status_code: int
    error: str
    message: str
    details: list[str] = Field(default_factory=list)
