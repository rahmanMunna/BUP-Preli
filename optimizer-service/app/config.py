"""Environment-driven settings.

Kept tiny and explicit: every value here is something a judge's scenario or the
organisers' wording could force us to change without a code edit.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

SolarSemantics = Literal["loss", "retain"]


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, ""))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    solar_factor_semantics: SolarSemantics
    """How `solar_reduction.factor` is read.

    `loss` (default) means the factor is the fraction LOST, so available solar
    becomes `solar * (1 - factor)` — this is what the NestJS prompt tells the
    interpreter to produce. `retain` means `solar * factor`. The two services
    MUST agree; see the README.
    """

    require_full_day: bool
    """Reject horizons that are not exactly 24 hours instead of warning."""

    solver_backend: str
    solver_time_limit_ms: int
    log_level: str

    def effective_solar(self, solar_kwh: float, factor: float) -> float:
        multiplier = (1.0 - factor) if self.solar_factor_semantics == "loss" else factor
        return max(0.0, solar_kwh * multiplier)


def load_settings() -> Settings:
    semantics = os.getenv("SOLAR_FACTOR_SEMANTICS", "loss").strip().lower()
    return Settings(
        solar_factor_semantics="retain" if semantics == "retain" else "loss",
        require_full_day=_bool("REQUIRE_FULL_DAY", False),
        solver_backend=os.getenv("SOLVER_BACKEND", "GLOP").strip().upper(),
        solver_time_limit_ms=_int("SOLVER_TIME_LIMIT_MS", 10_000),
        log_level=os.getenv("LOG_LEVEL", "INFO").strip().upper(),
    )


settings = load_settings()
