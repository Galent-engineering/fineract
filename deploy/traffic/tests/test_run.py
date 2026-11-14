import random

import httpx
import pytest
import respx

from harness_traffic.run import run
from tests.conftest import API


class _Quiet(random.Random):
    """random() always high: no injection, no savings journey, no later repayment."""

    def random(self) -> float:
        return 0.99


async def _no_sleep(_: float) -> None:
    return None


@respx.mock
async def test_exits_after_5_consecutive_failures(client, seed_result):
    route = respx.post(f"{API}/clients").mock(return_value=httpx.Response(500, json={"e": 1}))
    with pytest.raises(SystemExit) as ei:
        await run(client, seed_result, error_rate=0, slow_rate=0, sleep=_no_sleep, rng=_Quiet())
    assert ei.value.code != 0
    assert route.call_count == 5


@respx.mock
async def test_auth_failure_counts_as_failure(client, seed_result):
    route = respx.post(f"{API}/clients").mock(return_value=httpx.Response(401, json={"e": "unauthorized"}))
    with pytest.raises(SystemExit) as ei:
        await run(client, seed_result, error_rate=0, slow_rate=0, sleep=_no_sleep, rng=_Quiet())
    assert ei.value.code == 1
    assert route.call_count == 5


@respx.mock
async def test_success_resets_the_counter_and_injected_errors_do_not_count(client, seed_result):
    respx.post(f"{API}/clients").mock(return_value=httpx.Response(200, json={"clientId": 1}))
    respx.post(f"{API}/loans").mock(return_value=httpx.Response(200, json={"loanId": 2}))
    respx.post(url__regex=rf"{API}/loans/2.*").mock(return_value=httpx.Response(200, json={}))
    respx.post(f"{API}/savingsaccounts").mock(return_value=httpx.Response(200, json={"savingsId": 3}))
    respx.post(url__regex=rf"{API}/savingsaccounts/3.*").mock(return_value=httpx.Response(200, json={}))
    bad = respx.post(f"{API}/loans/999999999/transactions").mock(return_value=httpx.Response(404, json={"e": 1}))
    # error_rate=1: every tick sends an injected 4xx, 8 ticks, yet no SystemExit
    await run(client, seed_result, error_rate=1, slow_rate=0, max_ticks=8, sleep=_no_sleep, rng=random.Random(2))
    assert bad.call_count == 8


# ----------------------------------------------------------------------------------------------
# Behaviours the original tests missed (batch-3 review I-9): the failure counter must reset on a
# success, and injected 4xx must never reach the counter.

from harness_traffic import run as run_mod  # noqa: E402
from harness_traffic.journeys import JourneyOutcome  # noqa: E402


def _outcomes(monkeypatch, loans, injected=None):
    """Replace the loan journey (and optionally error injection) with scripted outcomes."""
    it = iter(loans)

    async def loan(_c, _s):
        o = next(it)
        return o() if callable(o) else o

    monkeypatch.setattr(run_mod, "run_loan_journey", loan)
    if injected is not None:

        async def inj(_c):
            return injected

        monkeypatch.setattr(run_mod, "inject_error", inj)


OK = JourneyOutcome("loan")
BAD = JourneyOutcome("loan", error="HTTP 500", status=500)


async def test_four_failures_one_success_four_failures_keeps_running(client, seed_result, monkeypatch):
    _outcomes(monkeypatch, [BAD] * 4 + [OK] + [BAD] * 4)
    await run(client, seed_result, error_rate=0, slow_rate=0, max_ticks=9, sleep=_no_sleep, rng=_Quiet())


async def test_five_failures_after_a_success_still_exit(client, seed_result, monkeypatch):
    _outcomes(monkeypatch, [BAD] * 4 + [OK] + [BAD] * 5)
    with pytest.raises(SystemExit):
        await run(client, seed_result, error_rate=0, slow_rate=0, max_ticks=10, sleep=_no_sleep, rng=_Quiet())


async def test_failed_injected_outcomes_never_count_toward_the_limit(client, seed_result, monkeypatch):
    injected_fail = JourneyOutcome("inject_error", error="HTTP 404", status=404, injected=True)
    # every tick: an injected failure plus a real loan journey; real failures stay at 4, then succeed
    _outcomes(monkeypatch, [BAD] * 4 + [OK] * 4, injected=injected_fail)
    await run(client, seed_result, error_rate=1, slow_rate=0, max_ticks=8, sleep=_no_sleep, rng=_Quiet())


async def test_unexpected_exceptions_count_as_failures_not_tracebacks(client, seed_result, monkeypatch):
    def boom():
        raise KeyError("clientId")

    _outcomes(monkeypatch, [boom] * 5)
    with pytest.raises(SystemExit) as ei:
        await run(client, seed_result, error_rate=0, slow_rate=0, max_ticks=5, sleep=_no_sleep, rng=_Quiet())
    assert ei.value.code == 1


async def test_a_single_unexpected_exception_is_survivable(client, seed_result, monkeypatch):
    def boom():
        raise KeyError("clientId")

    _outcomes(monkeypatch, [boom, OK, OK])
    await run(client, seed_result, error_rate=0, slow_rate=0, max_ticks=3, sleep=_no_sleep, rng=_Quiet())


# -------------------------------------------------------------------------- startup retry (M-8)


async def test_startup_retries_with_backoff_then_succeeds(client):
    slept: list[float] = []
    calls = {"n": 0}

    async def flaky_seed(_c):
        calls["n"] += 1
        if calls["n"] < 4:
            raise run_mod.FineractError(503, {"e": "starting"})
        return "seeded"

    async def sleep(s):
        slept.append(s)

    assert await run_mod.startup_seed(client, seed_fn=flaky_seed, sleep=sleep) == "seeded"
    assert len(slept) == 3
    assert slept == sorted(slept) and slept[0] < slept[-1]  # backs off


async def test_startup_gives_up_after_about_ten_minutes_with_exit_1(client):
    slept: list[float] = []

    async def always_down(_c):
        raise run_mod.FineractError(0, {"e": "connect"})

    async def sleep(s):
        slept.append(s)

    with pytest.raises(SystemExit) as ei:
        await run_mod.startup_seed(client, seed_fn=always_down, sleep=sleep)
    assert ei.value.code == 1
    assert 540 <= sum(slept) <= 660


async def test_startup_retries_unexpected_exceptions_too(client):
    calls = {"n": 0}

    async def odd_seed(_c):
        calls["n"] += 1
        if calls["n"] == 1:
            raise KeyError("id")  # e.g. a response without the expected field
        return "ok"

    async def sleep(_s):
        return None

    assert await run_mod.startup_seed(client, seed_fn=odd_seed, sleep=sleep) == "ok"
