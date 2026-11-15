"""Runtime-switchable journey rate: an SSM parameter, read about once a minute, with the env value as the fallback."""

from __future__ import annotations

import os
from typing import Callable

import boto3
from botocore.config import Config

from .journeys import log

RATE_MIN = 1.0
RATE_MAX = 120.0
RATE_PARAM_DEFAULT = "/harness/traffic/rate_per_min"
REFRESH_S = 60.0
READ_TIMEOUT_S = 5.0  # overall cap for one read in the traffic loop (run.py)


def clamp_rate(value: float) -> float:
    return max(RATE_MIN, min(RATE_MAX, value))


def parse_rate(raw: str | None) -> float | None:
    """A usable rate (clamped to 1..120) or None when the text is not a finite number."""
    try:
        v = float(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return clamp_rate(v)


def env_rate(default: str = "6") -> float:
    return parse_rate(os.environ.get("RATE_PER_MIN", default)) or clamp_rate(float(default))


def make_rate_source(
    param_name: str | None = None,
    fallback: float | None = None,
    get_parameter: Callable[[str], str] | None = None,
) -> Callable[[], float]:
    """Returns a function giving the current rate: the parameter when readable and numeric, else the last good value,
    else the env fallback. The SSM client is built once with short timeouts and no retries so an unreachable endpoint
    cannot hold the loop for minutes."""
    name = param_name or os.environ.get("RATE_PARAM_NAME", RATE_PARAM_DEFAULT)
    fb = env_rate() if fallback is None else clamp_rate(fallback)

    client = None

    def default_get(n: str) -> str:
        nonlocal client
        if client is None:
            client = boto3.client("ssm", config=Config(connect_timeout=3, read_timeout=3, retries={"max_attempts": 1}))
        return client.get_parameter(Name=n)["Parameter"]["Value"]

    getter = get_parameter or default_get
    last_good: float | None = None

    def source() -> float:
        nonlocal last_good
        use = fb if last_good is None else last_good
        try:
            rate = parse_rate(getter(name))
        except Exception as exc:  # noqa: BLE001  (unreadable: throttled, denied, missing, offline)
            log("rate_fallback", reason=type(exc).__name__, rate=use)
            return use
        if rate is None:
            log("rate_fallback", reason="not a number", rate=use)
            return use
        last_good = rate
        return rate

    return source
