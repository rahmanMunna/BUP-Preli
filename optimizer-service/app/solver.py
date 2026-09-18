"""Linear program for the GridWise dispatch problem, solved with OR-Tools.

Decision variables, per hour h of the horizon:

    grid_kwh[h]                  energy imported from the utility
    solar_used_kwh[h]            on-site solar actually consumed
    battery_charge[h]            energy pushed into the pack
    battery_discharge[h]         energy pulled out of the pack
    battery_energy_after_kwh[h]  stored energy at the END of the hour

Subject to, for every hour:

    grid + solar_used + discharge == demand + charge          (energy balance)
    energy_after == energy_before + charge * efficiency - discharge
    reserve <= energy_after <= capacity
    0 <= charge <= max_charge,  0 <= discharge <= max_discharge
    0 <= solar_used <= available solar
    grid <= cap                                               (max_grid_window)

and, across the horizon:

    energy_after[last] == initial energy                      (final neutrality)

Objective: minimise SUM(grid_kwh[h] * tariff[h]).

The model is a pure LP: charging losses make simultaneous charge/discharge
strictly wasteful, so no integer variables are needed to forbid it.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from ortools.linear_solver import pywraplp

from .config import Settings, settings as default_settings
from .schemas import HourlyPlanRow, SolveRequest
from .validator import PreparedScenario

logger = logging.getLogger(__name__)

EPSILON = 1e-9


class SolverError(RuntimeError):
    """The solver backend could not be created or crashed."""


class InfeasibleError(RuntimeError):
    """No dispatch satisfies the scenario, even after relaxation."""

    def __init__(self, message: str, details: list[str] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or []


@dataclass(frozen=True)
class Relaxation:
    """Which hard constraints may be violated at a price."""

    final_neutrality: bool = False
    grid_caps: bool = False
    reserves: bool = False

    def describe(self) -> list[str]:
        labels = []
        if self.final_neutrality:
            labels.append(
                "final neutrality: the battery could not end where it started"
            )
        if self.grid_caps:
            labels.append(
                "max_grid_window: demand could not be served within the cap"
            )
        if self.reserves:
            labels.append(
                "minimum_battery_reserve: the reserve could not be held"
            )
        return labels


@dataclass
class SolveOutcome:
    plan: list[HourlyPlanRow]
    total_grid_kwh: float
    total_cost_bdt: float
    peak_grid_kwh: float
    relaxations: list[str] = field(default_factory=list)
    solve_time_ms: float = 0.0
    backend: str = "GLOP"


# Escalating ladder: try the honest model first, then give up one constraint at
# a time, cheapest concession first. Anything relaxed is reported to the caller.
_LADDER = (
    Relaxation(),
    Relaxation(final_neutrality=True),
    Relaxation(final_neutrality=True, grid_caps=True),
    Relaxation(final_neutrality=True, grid_caps=True, reserves=True),
)


def solve(
    request: SolveRequest,
    prepared: PreparedScenario,
    config: Settings = default_settings,
) -> SolveOutcome:
    """Solves the scenario, relaxing soft constraints only if forced to."""
    started = time.perf_counter()
    failures: list[str] = []

    ladder = _LADDER if request.options.allow_relaxation else _LADDER[:1]

    for relaxation in ladder:
        outcome = _solve_once(request, prepared, relaxation, config)
        if outcome is not None:
            outcome.solve_time_ms = round((time.perf_counter() - started) * 1000, 3)
            outcome.relaxations = relaxation.describe()
            if outcome.relaxations:
                logger.warning(
                    "scenario=%s solved only after relaxing: %s",
                    request.scenario_id,
                    "; ".join(outcome.relaxations),
                )
            return outcome
        failures.append(
            "infeasible with "
            + (", ".join(relaxation.describe()) or "all constraints enforced")
        )

    raise InfeasibleError(
        "no feasible dispatch exists for this scenario",
        failures
        + [
            "check that demand can be met: a no_charge_window combined with a "
            "minimum_battery_reserve above the starting charge is a common cause"
        ],
    )


def _solve_once(
    request: SolveRequest,
    prepared: PreparedScenario,
    relaxation: Relaxation,
    config: Settings,
) -> SolveOutcome | None:
    battery = request.battery
    hours = prepared.hours

    solver = pywraplp.Solver.CreateSolver(config.solver_backend)
    if solver is None:
        raise SolverError(
            f"OR-Tools backend {config.solver_backend!r} is not available"
        )
    solver.SetTimeLimit(config.solver_time_limit_ms)
    infinity = solver.infinity()

    grid, solar_used, charge, discharge, energy = [], [], [], [], []
    penalties = []

    # A penalty has to outweigh any conceivable tariff saving, or the solver
    # would happily "buy" a violation.
    max_tariff = max((hour.tariff_bdt_per_kwh for hour in hours), default=0.0)
    penalty_rate = max(1_000.0, max_tariff * 1_000.0)

    for index, limits in enumerate(hours):
        suffix = f"_{limits.hour}"

        cap = infinity
        if limits.grid_cap_kwh is not None and not relaxation.grid_caps:
            cap = limits.grid_cap_kwh
        grid.append(solver.NumVar(0.0, cap, f"grid_kwh{suffix}"))

        solar_used.append(
            solver.NumVar(0.0, limits.solar_kwh, f"solar_used_kwh{suffix}")
        )
        charge.append(
            solver.NumVar(
                0.0,
                0.0 if limits.charge_blocked else battery.charge_limit,
                f"battery_charge{suffix}",
            )
        )
        discharge.append(
            solver.NumVar(
                0.0,
                0.0 if limits.discharge_blocked else battery.discharge_limit,
                f"battery_discharge{suffix}",
            )
        )

        floor = 0.0 if relaxation.reserves else min(
            limits.reserve_kwh, battery.capacity_kwh
        )
        energy.append(
            solver.NumVar(
                floor, battery.capacity_kwh, f"battery_energy_after_kwh{suffix}"
            )
        )

        if relaxation.reserves and limits.reserve_kwh > 0:
            shortfall = solver.NumVar(0.0, infinity, f"reserve_shortfall{suffix}")
            solver.Add(energy[index] + shortfall >= limits.reserve_kwh)
            penalties.append(shortfall)

        if relaxation.grid_caps and limits.grid_cap_kwh is not None:
            excess = solver.NumVar(0.0, infinity, f"grid_cap_excess{suffix}")
            solver.Add(grid[index] <= limits.grid_cap_kwh + excess)
            penalties.append(excess)

        # Energy balance: everything supplied meets everything consumed.
        solver.Add(
            grid[index] + solar_used[index] + discharge[index]
            == limits.demand_kwh + charge[index],
            f"energy_balance{suffix}",
        )

        # Storage dynamics.
        previous = energy[index - 1] if index else battery.initial_soc_kwh
        solver.Add(
            energy[index]
            == previous + charge[index] * battery.efficiency - discharge[index],
            f"battery_dynamics{suffix}",
        )

    if request.options.enforce_final_neutrality and energy:
        if relaxation.final_neutrality:
            over = solver.NumVar(0.0, infinity, "final_surplus")
            under = solver.NumVar(0.0, infinity, "final_deficit")
            solver.Add(energy[-1] - over + under == battery.initial_soc_kwh)
            penalties.extend([over, under])
        else:
            solver.Add(
                energy[-1] == battery.initial_soc_kwh, "final_neutrality"
            )

    objective = solver.Objective()
    for index, limits in enumerate(hours):
        objective.SetCoefficient(grid[index], limits.tariff_bdt_per_kwh)

    peak_penalty = request.options.peak_penalty_bdt_per_kwh
    if peak_penalty > 0:
        peak = solver.NumVar(0.0, infinity, "peak_grid_kwh")
        for variable in grid:
            solver.Add(peak >= variable)
        objective.SetCoefficient(peak, peak_penalty)

    for variable in penalties:
        objective.SetCoefficient(variable, penalty_rate)

    objective.SetMinimization()

    status = solver.Solve()
    if status not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
        if status in (pywraplp.Solver.ABNORMAL, pywraplp.Solver.NOT_SOLVED):
            raise SolverError(f"solver returned status {status}")
        return None

    plan = _extract_plan(
        hours, grid, solar_used, charge, discharge, energy, battery.efficiency
    )
    total_grid = round(sum(row.grid_kwh for row in plan), 6)
    total_cost = round(sum(row.cost_bdt for row in plan), 6)
    peak_grid = round(max((row.grid_kwh for row in plan), default=0.0), 6)

    return SolveOutcome(
        plan=plan,
        total_grid_kwh=total_grid,
        total_cost_bdt=total_cost,
        peak_grid_kwh=peak_grid,
        backend=config.solver_backend,
    )


def _extract_plan(
    hours,
    grid,
    solar_used,
    charge,
    discharge,
    energy,
    efficiency: float,
) -> list[HourlyPlanRow]:
    """Reads the solution back, cleaning up LP dust before anyone sees it."""
    plan: list[HourlyPlanRow] = []

    for index, limits in enumerate(hours):
        charge_kwh = _clean(charge[index].solution_value())
        discharge_kwh = _clean(discharge[index].solution_value())

        # With a lossless pack, charging and discharging in the same hour costs
        # nothing, so the LP may report both. Netting them is exactly neutral
        # for the balance and the stored energy, and far easier to read.
        if efficiency >= 1.0 - EPSILON and charge_kwh > 0 and discharge_kwh > 0:
            overlap = min(charge_kwh, discharge_kwh)
            charge_kwh -= overlap
            discharge_kwh -= overlap

        grid_kwh = _clean(grid[index].solution_value())
        solar_used_kwh = _clean(solar_used[index].solution_value())
        energy_after = _clean(energy[index].solution_value())

        plan.append(
            HourlyPlanRow(
                hour=limits.hour,
                demand_kwh=round(limits.demand_kwh, 6),
                solar_kwh=round(limits.solar_kwh, 6),
                solar_used_kwh=solar_used_kwh,
                solar_curtailed_kwh=_clean(limits.solar_kwh - solar_used_kwh),
                battery_charge_kwh=charge_kwh,
                battery_discharge_kwh=discharge_kwh,
                battery_energy_after_kwh=energy_after,
                battery_soc_kwh=energy_after,
                grid_kwh=grid_kwh,
                tariff_bdt_per_kwh=round(limits.tariff_bdt_per_kwh, 6),
                cost_bdt=round(grid_kwh * limits.tariff_bdt_per_kwh, 6),
            )
        )

    return plan


def _clean(value: float) -> float:
    """Clamps solver noise to zero and rounds to a sane number of decimals."""
    if abs(value) < 1e-9:
        return 0.0
    return round(max(value, 0.0), 6)
