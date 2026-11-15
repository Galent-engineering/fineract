"""Traffic generator: steady journeys with optional error/latency injection. Exits non-zero after 5 consecutive failures."""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
from collections import deque
from typing import Awaitable, Callable

import boto3

from .client import FineractClient, FineractError  # noqa: F401  (re-exported for tests)
from .journeys import (
    JourneyOutcome,
    inject_error,
    inject_slow,
    log,
    run_loan_journey,
    run_repayment,
    run_savings_journey,
)
from .rate import REFRESH_S, env_rate, make_rate_source
from .seed import SeedResult, seed

MAX_CONSECUTIVE_FAILURES = 5
SAVINGS_PER_LOAN = 0.25
LATER_REPAYMENT_RATE = 0.3


async def _guard(journey: str, make: Callable[[], Awaitable[JourneyOutcome]]) -> JourneyOutcome:
    """An unexpected exception (missing response field, ...) is a failed journey, not a crash with a traceback."""
    try:
        return await make()
    except Exception as exc:  # noqa: BLE001
        return JourneyOutcome(journey, error=f"{type(exc).__name__}: {exc}")


async def run(
    client: FineractClient,
    seed_result: SeedResult,
    *,
    rate_per_min: float = 6,
    error_rate: float = 0.02,
    slow_rate: float = 0.01,
    max_ticks: int | None = None,
    rate_source: Callable[[], float] | None = None,
    rate_refresh_s: float = REFRESH_S,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    rng: random.Random | None = None,
) -> None:
    rng = rng or random.Random()
    interval = 60.0 / rate_per_min
    last_refresh = time.monotonic()
    loans: deque[int] = deque(maxlen=500)
    failures = 0
    tick = 0
    while max_ticks is None or tick < max_ticks:
        tick += 1
        started = time.monotonic()
        if rate_source is not None and started - last_refresh >= rate_refresh_s:
            last_refresh = started
            new_rate = await asyncio.to_thread(rate_source)  # blocking boto3 call stays off the event loop
            if new_rate != rate_per_min:
                log("rate_change", old=rate_per_min, new=new_rate)
                rate_per_min, interval = new_rate, 60.0 / new_rate
        outcomes: list[JourneyOutcome] = []
        if rng.random() < error_rate:
            outcomes.append(await _guard("inject_error", lambda: inject_error(client)))  # expected 4xx: logged, not counted
        if rng.random() < slow_rate:
            outcomes.append(await _guard("inject_slow", lambda: inject_slow(client)))
        loan = await _guard("loan", lambda: run_loan_journey(client, seed_result))
        outcomes.append(loan)
        if "loan" in loan.ids and "disburse" in loan.steps:
            loans.append(loan.ids["loan"])
        if rng.random() < SAVINGS_PER_LOAN:
            outcomes.append(await _guard("savings", lambda: run_savings_journey(client, seed_result)))
        if loans and rng.random() < LATER_REPAYMENT_RATE:
            loan_id = rng.choice(list(loans))
            outcomes.append(await _guard("repayment", lambda: run_repayment(client, loan_id)))

        for o in outcomes:
            log("journey", journey=o.journey, status=o.status or 200, steps=len(o.steps), error=o.error, injected=o.injected)
            if o.injected is True:
                continue
            failures = 0 if o.ok else failures + 1
            if failures >= MAX_CONSECUTIVE_FAILURES:
                log("fatal", reason=f"{failures} consecutive failures")
                raise SystemExit(1)
        await sleep(max(0.0, interval - (time.monotonic() - started)))  # keep the configured rate


def _credentials(secret_arn: str) -> tuple[str, str]:
    raw = boto3.client("secretsmanager").get_secret_value(SecretId=secret_arn)["SecretString"]
    s = json.loads(raw)
    return s["username"], s["password"]


STARTUP_MAX_WAIT_S = 600
STARTUP_FIRST_DELAY_S = 5.0
STARTUP_MAX_DELAY_S = 60.0


async def startup_seed(
    client: FineractClient,
    *,
    seed_fn: Callable[[FineractClient], Awaitable[SeedResult]] = seed,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    max_wait_s: float = STARTUP_MAX_WAIT_S,
) -> SeedResult:
    """The startup lookups can fail while Fineract boots (about 7 min after a resume): retry with backoff for up to
    ten minutes instead of crash-looping under ECS restart throttling. Any exception is retried, including
    unexpected ones (KeyError on a response field, StopIteration inside seed)."""
    waited, delay = 0.0, STARTUP_FIRST_DELAY_S
    while True:
        try:
            return await seed_fn(client)
        except Exception as exc:  # noqa: BLE001
            status = getattr(exc, "status", None)
            log("startup_retry", error=f"{type(exc).__name__}", status=status, waited_s=waited)
            if waited >= max_wait_s:
                log("fatal", reason=f"startup lookup failed for {int(waited)}s: {type(exc).__name__} {status}")
                raise SystemExit(1) from exc
            await sleep(delay)
            waited += delay
            delay = min(delay * 2, STARTUP_MAX_DELAY_S)


async def main_async() -> None:
    base = os.environ["FINERACT_BASE_URL"]
    username, password = _credentials(os.environ["SECRET_ARN"])
    client = FineractClient(base, username, password)
    seed_result = await startup_seed(client)
    fallback = env_rate()
    source = make_rate_source(fallback=fallback)
    initial = await asyncio.to_thread(source)
    log("start", rate_per_min=initial)
    await run(
        client,
        seed_result,
        rate_per_min=initial,
        rate_source=source,
        error_rate=float(os.environ.get("ERROR_RATE", "0.02")),
        slow_rate=float(os.environ.get("SLOW_RATE", "0.01")),
    )


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
