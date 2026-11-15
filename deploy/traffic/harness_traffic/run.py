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
from .rate import READ_TIMEOUT_S, REFRESH_S, env_rate, make_rate_source
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


MAX_IN_FLIGHT = 20
TRAFFIC_TIMEOUT_S = 15.0


def _is_outage(o: JourneyOutcome) -> bool:
    """A timeout (status 0) or a 5xx means the backend is down or degraded: that is what the harness is for, so it is
    logged and counted by monitoring but never makes the generator exit (a restart would hide the outage)."""
    return o.status is not None and (o.status == 0 or o.status >= 500)


async def run(
    client: FineractClient,
    seed_result: SeedResult,
    *,
    rate_per_min: float = 6,
    error_rate: float = 0.02,
    slow_rate: float = 0.01,
    max_ticks: int | None = None,
    max_in_flight: int = MAX_IN_FLIGHT,
    rate_source: Callable[[], float] | None = None,
    rate_refresh_s: float = REFRESH_S,
    rate_timeout_s: float = READ_TIMEOUT_S,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    rng: random.Random | None = None,
) -> None:
    """Launches one journey set per tick ON SCHEDULE (every 60/rate seconds) without waiting for the previous one, so slow
    or hung requests do not lower the offered rate. At most `max_in_flight` sets run at once; a tick that would exceed
    the cap is skipped and logged."""
    rng = rng or random.Random()
    interval = 60.0 / rate_per_min
    loans: deque[int] = deque(maxlen=500)
    state = {"failures": 0, "fatal": False}
    in_flight: set[asyncio.Task[None]] = set()

    async def one_set() -> None:
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
            log("journey", journey=o.journey, status=o.status if o.status is not None else 200, steps=len(o.steps),
                error=o.error, injected=o.injected)
            if o.injected is True:
                continue
            if o.ok:
                state["failures"] = 0
            elif not _is_outage(o):  # auth/config style failures (4xx, unexpected exceptions) are fatal when they persist
                state["failures"] += 1
                if state["failures"] >= MAX_CONSECUTIVE_FAILURES:
                    state["fatal"] = True

    last_refresh = time.monotonic()
    next_at = time.monotonic()
    tick = 0
    while (max_ticks is None or tick < max_ticks) and not state["fatal"]:
        tick += 1
        now = time.monotonic()
        if rate_source is not None and now - last_refresh >= rate_refresh_s:
            last_refresh = now
            try:  # blocking boto3 call stays off the event loop, and never holds it past the timeout
                new_rate = await asyncio.wait_for(asyncio.to_thread(rate_source), rate_timeout_s)
            except asyncio.TimeoutError:
                log("rate_fallback", reason="read timed out", rate=rate_per_min)
                new_rate = rate_per_min
            if new_rate != rate_per_min:
                log("rate_change", old=rate_per_min, new=new_rate)
                rate_per_min, interval = new_rate, 60.0 / new_rate
        if len(in_flight) >= max_in_flight:
            log("tick_skipped", reason="in_flight_cap", in_flight=len(in_flight), cap=max_in_flight)
        else:
            task = asyncio.ensure_future(one_set())
            in_flight.add(task)
            task.add_done_callback(in_flight.discard)
        next_at += interval
        delay = next_at - time.monotonic()
        if delay < -interval:  # the scheduler itself stalled; do not fire a burst to catch up
            next_at = time.monotonic()
            delay = 0.0
        await sleep(max(0.0, delay))
        await asyncio.sleep(0)  # let freshly launched sets start even with an injected no-op sleep
    if in_flight:
        await asyncio.gather(*list(in_flight))
    if state["fatal"]:
        log("fatal", reason=f"{state['failures']} consecutive failures")
        raise SystemExit(1)


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
    client = FineractClient(base, username, password, timeout=TRAFFIC_TIMEOUT_S)
    seed_result = await startup_seed(client)
    fallback = env_rate()
    source = make_rate_source(fallback=fallback)
    try:
        initial = await asyncio.wait_for(asyncio.to_thread(source), READ_TIMEOUT_S)
    except asyncio.TimeoutError:
        initial = fallback
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
