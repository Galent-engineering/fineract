import random

import pytest

from harness_traffic import rate
from harness_traffic.rate import make_rate_source, parse_rate
from harness_traffic.run import run


@pytest.mark.parametrize("raw,want", [("6", 6), ("60", 60), (" 12.5 ", 12.5), ("0", 1), ("-5", 1), ("500", 120), ("120", 120), ("1", 1)])
def test_bounds_clamp_to_1_120(raw, want):
    assert parse_rate(raw) == want


@pytest.mark.parametrize("raw", ["", "abc", "nan", "inf", None])
def test_unparseable_is_none(raw):
    assert parse_rate(raw) is None


def test_reads_the_parameter_by_name():
    seen = []
    src = make_rate_source("/harness/traffic/rate_per_min", 6, lambda n: seen.append(n) or "60")
    assert src() == 60 and seen == ["/harness/traffic/rate_per_min"]


def test_out_of_bounds_parameter_is_clamped():
    assert make_rate_source("p", 6, lambda n: "9999")() == 120


def test_unreadable_parameter_falls_back_to_env_rate():
    def boom(_):
        raise RuntimeError("AccessDenied")

    assert make_rate_source("p", 7, boom)() == 7


def test_garbage_parameter_falls_back():
    assert make_rate_source("p", 7, lambda n: "fast")() == 7


def test_fallback_is_itself_clamped():
    assert make_rate_source("p", 5000, lambda n: "x")() == 120


def test_env_rate(monkeypatch):
    monkeypatch.setenv("RATE_PER_MIN", "30")
    assert rate.env_rate() == 30
    monkeypatch.setenv("RATE_PER_MIN", "oops")
    assert rate.env_rate() == 6


class _Quiet(random.Random):
    def random(self) -> float:
        return 0.99


async def test_run_picks_up_a_new_rate_between_ticks(client, seed_result, monkeypatch):
    # loan journeys fail fast (no http mock) -> stub the journeys so only the pacing is exercised
    from harness_traffic import run as run_mod
    from harness_traffic.journeys import JourneyOutcome

    async def ok(*_a, **_k):
        return JourneyOutcome("loan")

    monkeypatch.setattr(run_mod, "run_loan_journey", ok)
    sleeps: list[float] = []
    rates = iter([60.0, 60.0, 6.0])

    async def rec(s: float) -> None:
        sleeps.append(s)

    await run(client, seed_result, rate_per_min=6, error_rate=0, slow_rate=0, max_ticks=3, sleep=rec,
              rng=_Quiet(), rate_source=lambda: next(rates), rate_refresh_s=0)
    # tick1 refresh->60 (1 s interval), tick2 ->60, tick3 ->6 (10 s), tick4: source exhausted would raise
    assert [round(x) for x in sleeps[:3]] == [1, 1, 10]
