"""Input validation, directive normalisation and post-solve verification.

Three jobs:

1. `validate_request` rejects a scenario that cannot describe a real day.
2. `prepare_constraints` turns directives into per-hour limits the solver can
   consume, normalising the sloppy shapes a language model produces.
3. `validate_solution` re-checks the solved plan against the physics and the
   directives. A solver that says "optimal" can still be wrong if the model was
   built wrong, so the answer is verified before it leaves the service.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import Settings, settings as default_settings
from .schemas import (
    HOURS_IN_DAY,
    Directive,
    DirectiveType,
    HourlyPlanRow,
    SolveRequest,
    ValidationReport,
)

# LP solutions carry floating point dust; anything under this is not a violation.
TOLERANCE = 1e-4


class InvalidInputError(ValueError):
    """The scenario cannot be optimized as given."""

    def __init__(self, message: str, details: list[str] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or []


@dataclass
class HourConstraints:
    """Everything the directives say about a single hour."""

    hour: int
    demand_kwh: float
    raw_solar_kwh: float
    solar_kwh: float
    """Solar actually available, after `solar_reduction`."""
    tariff_bdt_per_kwh: float
    charge_blocked: bool = False
    discharge_blocked: bool = False
    grid_cap_kwh: float | None = None
    reserve_kwh: float = 0.0
    """Floor the stored energy must respect at the END of this hour."""


@dataclass
class PreparedScenario:
    hours: list[HourConstraints]
    warnings: list[str] = field(default_factory=list)

    @property
    def hour_indexes(self) -> list[int]:
        return [hour.hour for hour in self.hours]


def validate_request(
    request: SolveRequest, config: Settings = default_settings
) -> list[str]:
    """Hard-fails on an impossible scenario; returns warnings for the rest."""
    errors: list[str] = []
    warnings: list[str] = []

    hours = [hour.hour for hour in request.hours]

    duplicates = sorted({hour for hour in hours if hours.count(hour) > 1})
    if duplicates:
        errors.append(f"duplicate hour indexes: {duplicates}")

    if hours != sorted(hours):
        warnings.append("hours were not ascending and have been sorted")

    if len(request.hours) != HOURS_IN_DAY:
        message = (
            f"horizon has {len(request.hours)} hour(s), not {HOURS_IN_DAY}"
        )
        if config.require_full_day:
            errors.append(message)
        else:
            warnings.append(f"{message}; solving the hours that were supplied")

    battery = request.battery
    if battery.min_reserve_kwh > battery.capacity_kwh + TOLERANCE:
        errors.append(
            f"min_reserve_kwh ({battery.min_reserve_kwh}) exceeds capacity_kwh "
            f"({battery.capacity_kwh})"
        )
    if battery.initial_soc_kwh > battery.capacity_kwh + TOLERANCE:
        errors.append(
            f"initial_soc_kwh ({battery.initial_soc_kwh}) exceeds capacity_kwh "
            f"({battery.capacity_kwh})"
        )
    if battery.initial_soc_kwh + TOLERANCE < battery.min_reserve_kwh:
        warnings.append(
            "battery starts below its own minimum reserve; it must charge up "
            "before it can serve any load"
        )

    if errors:
        raise InvalidInputError("scenario is not solvable as described", errors)

    return warnings


def prepare_constraints(
    request: SolveRequest, config: Settings = default_settings
) -> PreparedScenario:
    """Collapses the directive list into per-hour limits."""
    battery = request.battery
    hours = sorted(request.hours, key=lambda hour: hour.hour)
    horizon = {hour.hour for hour in hours}

    constraints = {
        hour.hour: HourConstraints(
            hour=hour.hour,
            demand_kwh=hour.demand_kwh,
            raw_solar_kwh=hour.solar_kwh,
            solar_kwh=hour.solar_kwh,
            tariff_bdt_per_kwh=hour.tariff_bdt_per_kwh,
            reserve_kwh=min(battery.min_reserve_kwh, battery.capacity_kwh),
        )
        for hour in hours
    }
    warnings: list[str] = []

    for position, directive in enumerate(request.directives):
        if directive.directive_type is DirectiveType.NO_OP:
            continue

        adjustment = directive.structured_adjustment or {}
        label = f"directive[{position}] {directive.directive_type.value}"
        target_hours = _target_hours(adjustment, horizon, label, warnings)
        if not target_hours:
            continue

        match directive.directive_type:
            case DirectiveType.SOLAR_REDUCTION:
                factor = _fraction(adjustment.get("factor"))
                if factor is None:
                    warnings.append(f"{label}: ignored, factor is not a number in 0-1")
                    continue
                for hour in target_hours:
                    limits = constraints[hour]
                    limits.solar_kwh = min(
                        limits.solar_kwh,
                        config.effective_solar(limits.raw_solar_kwh, factor),
                    )

            case DirectiveType.NO_CHARGE_WINDOW:
                for hour in target_hours:
                    constraints[hour].charge_blocked = True

            case DirectiveType.NO_DISCHARGE_WINDOW:
                for hour in target_hours:
                    constraints[hour].discharge_blocked = True

            case DirectiveType.MAX_GRID_WINDOW:
                cap = _number(
                    adjustment.get("max_kwh", adjustment.get("max_grid_kwh"))
                )
                if cap is None or cap < 0:
                    warnings.append(
                        f"{label}: ignored, max_kwh is not a non-negative number"
                    )
                    continue
                for hour in target_hours:
                    limits = constraints[hour]
                    limits.grid_cap_kwh = (
                        cap
                        if limits.grid_cap_kwh is None
                        else min(limits.grid_cap_kwh, cap)
                    )

            case DirectiveType.MINIMUM_BATTERY_RESERVE:
                reserve = _reserve_kwh(adjustment, battery.capacity_kwh)
                if reserve is None:
                    warnings.append(
                        f"{label}: ignored, reserve_kwh is not a non-negative number"
                    )
                    continue
                if reserve > battery.capacity_kwh:
                    warnings.append(
                        f"{label}: reserve {reserve} kWh clamped to capacity "
                        f"{battery.capacity_kwh} kWh"
                    )
                    reserve = battery.capacity_kwh
                for hour in target_hours:
                    limits = constraints[hour]
                    limits.reserve_kwh = max(limits.reserve_kwh, reserve)

    return PreparedScenario(
        hours=[constraints[hour] for hour in sorted(constraints)],
        warnings=warnings,
    )


def validate_solution(
    request: SolveRequest,
    prepared: PreparedScenario,
    plan: list[HourlyPlanRow],
    relaxations: list[str],
) -> ValidationReport:
    """Re-derives every constraint from the answer the solver returned."""
    battery = request.battery
    checks: list[str] = []
    violations: list[str] = []

    if len(plan) != len(prepared.hours):
        violations.append(
            f"plan has {len(plan)} row(s) for a {len(prepared.hours)} hour horizon"
        )
        return ValidationReport(passed=False, checks=checks, violations=violations)

    checks.append(f"{len(plan)} hour(s) scheduled")
    if len(plan) == HOURS_IN_DAY:
        checks.append("full 24 hour horizon")

    previous_energy = battery.initial_soc_kwh

    for row, limits in zip(plan, prepared.hours, strict=True):
        where = f"hour {row.hour}"

        supply = row.grid_kwh + row.solar_used_kwh + row.battery_discharge_kwh
        sink = row.demand_kwh + row.battery_charge_kwh
        if abs(supply - sink) > TOLERANCE:
            violations.append(
                f"{where}: energy balance off by {supply - sink:.6f} kWh "
                f"(supply {supply:.3f} vs demand+charge {sink:.3f})"
            )

        if row.solar_used_kwh > limits.solar_kwh + TOLERANCE:
            violations.append(
                f"{where}: used {row.solar_used_kwh:.3f} kWh of solar but only "
                f"{limits.solar_kwh:.3f} kWh was available"
            )

        expected_energy = (
            previous_energy
            + row.battery_charge_kwh * battery.efficiency
            - row.battery_discharge_kwh
        )
        if abs(expected_energy - row.battery_energy_after_kwh) > TOLERANCE:
            violations.append(
                f"{where}: stored energy {row.battery_energy_after_kwh:.3f} kWh does "
                f"not follow from the previous hour ({expected_energy:.3f} kWh)"
            )

        if row.battery_energy_after_kwh > battery.capacity_kwh + TOLERANCE:
            violations.append(
                f"{where}: stored energy exceeds capacity "
                f"({row.battery_energy_after_kwh:.3f} > {battery.capacity_kwh})"
            )
        if row.battery_energy_after_kwh + TOLERANCE < limits.reserve_kwh:
            violations.append(
                f"{where}: stored energy {row.battery_energy_after_kwh:.3f} kWh is "
                f"below the required reserve {limits.reserve_kwh:.3f} kWh"
            )

        if row.battery_charge_kwh > battery.charge_limit + TOLERANCE:
            violations.append(
                f"{where}: charge {row.battery_charge_kwh:.3f} kWh exceeds the "
                f"{battery.charge_limit} kWh limit"
            )
        if row.battery_discharge_kwh > battery.discharge_limit + TOLERANCE:
            violations.append(
                f"{where}: discharge {row.battery_discharge_kwh:.3f} kWh exceeds the "
                f"{battery.discharge_limit} kWh limit"
            )

        if limits.charge_blocked and row.battery_charge_kwh > TOLERANCE:
            violations.append(f"{where}: charged inside a no_charge_window")
        if limits.discharge_blocked and row.battery_discharge_kwh > TOLERANCE:
            violations.append(f"{where}: discharged inside a no_discharge_window")
        if (
            limits.grid_cap_kwh is not None
            and row.grid_kwh > limits.grid_cap_kwh + TOLERANCE
            and "max_grid_window" not in " ".join(relaxations)
        ):
            violations.append(
                f"{where}: imported {row.grid_kwh:.3f} kWh against a "
                f"{limits.grid_cap_kwh:.3f} kWh cap"
            )

        for value, name in (
            (row.grid_kwh, "grid_kwh"),
            (row.solar_used_kwh, "solar_used_kwh"),
            (row.battery_charge_kwh, "battery_charge_kwh"),
            (row.battery_discharge_kwh, "battery_discharge_kwh"),
        ):
            if value < -TOLERANCE:
                violations.append(f"{where}: {name} is negative ({value:.6f})")

        previous_energy = row.battery_energy_after_kwh

    checks.append("energy balance, battery limits and directive windows checked")

    if request.options.enforce_final_neutrality:
        drift = plan[-1].battery_energy_after_kwh - battery.initial_soc_kwh
        neutrality_relaxed = any("final neutrality" in item for item in relaxations)
        if abs(drift) > TOLERANCE and not neutrality_relaxed:
            violations.append(
                f"battery ends at {plan[-1].battery_energy_after_kwh:.3f} kWh but "
                f"started at {battery.initial_soc_kwh:.3f} kWh (drift {drift:+.3f})"
            )
        elif neutrality_relaxed:
            checks.append(f"final neutrality relaxed, drift {drift:+.3f} kWh")
        else:
            checks.append("battery ends the horizon at its starting energy")

    return ValidationReport(
        passed=not violations, checks=checks, violations=violations
    )


def _target_hours(
    adjustment: dict,
    horizon: set[int],
    label: str,
    warnings: list[str],
) -> list[int]:
    """Hours a directive applies to; absent `hours` means the whole horizon."""
    raw = adjustment.get("hours")
    if raw is None:
        return sorted(horizon)
    if not isinstance(raw, list):
        warnings.append(f"{label}: ignored, 'hours' is not a list")
        return []

    hours: list[int] = []
    for entry in raw:
        value = _number(entry)
        if value is None or value != int(value):
            warnings.append(f"{label}: ignored hour {entry!r}, not an integer")
            continue
        hour = int(value)
        if hour not in horizon:
            warnings.append(f"{label}: hour {hour} is outside the scenario horizon")
            continue
        hours.append(hour)

    if not hours:
        warnings.append(f"{label}: ignored, no valid hour remained")
    return sorted(set(hours))


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _fraction(value: object) -> float | None:
    """Accepts 0.2 and 20 for "20 percent"."""
    number = _number(value)
    if number is None or number < 0:
        return None
    if number <= 1:
        return number
    if number <= 100:
        return number / 100.0
    return None


def _reserve_kwh(adjustment: dict, capacity_kwh: float) -> float | None:
    reserve = _number(adjustment.get("reserve_kwh", adjustment.get("reserve")))
    if reserve is None:
        percent = _number(adjustment.get("reserve_percent"))
        if percent is None or not 0 <= percent <= 100:
            return None
        reserve = percent / 100.0 * capacity_kwh
    return reserve if reserve >= 0 else None
