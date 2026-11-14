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
