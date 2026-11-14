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

from .client import FineractClient, FineractError
from .journeys import (
    JourneyOutcome,
    inject_error,
    inject_slow,
    log,
    run_loan_journey,
    run_repayment,
    run_savings_journey,
)
from .seed import SeedResult, seed

MAX_CONSECUTIVE_FAILURES = 5
SAVINGS_PER_LOAN = 0.25
LATER_REPAYMENT_RATE = 0.3


async def run(
    client: FineractClient,
    seed_result: SeedResult,
    *,
    rate_per_min: float = 6,
    error_rate: float = 0.02,
    slow_rate: float = 0.01,
    max_ticks: int | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    rng: random.Random | None = None,
) -> None:
    rng = rng or random.Random()
    interval = 60.0 / rate_per_min
    loans: deque[int] = deque(maxlen=500)
    failures = 0
    tick = 0
    while max_ticks is None or tick < max_ticks:
        tick += 1
        started = time.monotonic()
        outcomes: list[JourneyOutcome] = []
        if rng.random() < error_rate:
            outcomes.append(await inject_error(client))  # expected 4xx: logged, not counted as a failure
        if rng.random() < slow_rate:
            outcomes.append(await inject_slow(client))
        loan = await run_loan_journey(client, seed_result)
        outcomes.append(loan)
        if "loan" in loan.ids and "disburse" in loan.steps:
            loans.append(loan.ids["loan"])
        if rng.random() < SAVINGS_PER_LOAN:
            outcomes.append(await run_savings_journey(client, seed_result))
        if loans and rng.random() < LATER_REPAYMENT_RATE:
            outcomes.append(await run_repayment(client, rng.choice(list(loans))))

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


async def main_async() -> None:
    base = os.environ["FINERACT_BASE_URL"]
    username, password = _credentials(os.environ["SECRET_ARN"])
    client = FineractClient(base, username, password)
    try:
        seed_result = await seed(client)
    except FineractError as exc:
        log("fatal", reason=f"startup lookup failed: HTTP {exc.status}")
        raise SystemExit(1) from exc
    log("start", rate_per_min=os.environ.get("RATE_PER_MIN", "6"))
    await run(
        client,
        seed_result,
        rate_per_min=float(os.environ.get("RATE_PER_MIN", "6")),
        error_rate=float(os.environ.get("ERROR_RATE", "0.02")),
        slow_rate=float(os.environ.get("SLOW_RATE", "0.01")),
    )


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
