"""Behavioural tests for pause.sh / resume.sh using a stub aws CLI (no AWS calls, no sleeping)."""
import json
import os
import stat
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).parent
SCRIPTS = HERE.parent
SVC = ["harness:fineract", "harness:webapp", "harness:traffic", "harness-obs:obs"]


@pytest.fixture
def env(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    aws = bin_dir / "aws"
    aws.write_text(f"#!/bin/sh\nexec python3 {HERE / 'fake_aws.py'} \"$@\"\n")
    for name, body in {"sleep": "exit 0", "curl": "echo 200"}.items():
        (bin_dir / name).write_text(f"#!/bin/sh\n{body}\n")
    for f in bin_dir.iterdir():
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    state = tmp_path / "state.json"
    e = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_STATE": str(state)}

    def run(script, **st):
        base = {"ssm": {}, "ssm_errors": {}, "counts": {k: 1 for k in SVC}, "rds": "available"}
        base.update(st)
        state.write_text(json.dumps(base))
        p = subprocess.run(["bash", str(SCRIPTS / script)], env=e, capture_output=True, text=True, timeout=60)
        return p, json.loads(state.read_text())

    return run


def test_pause_saves_counts_and_scales_to_zero(env):
    p, st = env("pause.sh")
    assert p.returncode == 0, p.stderr
    assert json.loads(st["ssm"]["/harness/desired-counts"]) == {k: 1 for k in SVC}
    assert st["ssm"]["/harness/paused"] == "true"
    assert all(v == 0 for v in st["counts"].values())


def test_pause_rerun_after_partial_failure_keeps_the_good_snapshot(env):
    good = json.dumps({k: 1 for k in SVC})
    partial = {"harness:fineract": 0, "harness:webapp": 0, "harness:traffic": 0, "harness-obs:obs": 1}
    p, st = env("pause.sh", ssm={"/harness/paused": "true", "/harness/desired-counts": good}, counts=partial)
    assert p.returncode == 0, p.stderr
    assert json.loads(st["ssm"]["/harness/desired-counts"]) == {k: 1 for k in SVC}


def test_pause_does_not_overwrite_when_all_zero(env):
    good = json.dumps({k: 2 for k in SVC})
    p, st = env("pause.sh", ssm={"/harness/desired-counts": good}, counts={k: 0 for k in SVC})
    assert p.returncode == 0, p.stderr
    assert json.loads(st["ssm"]["/harness/desired-counts"]) == {k: 2 for k in SVC}


def test_resume_restores_counts_clears_flag_and_snapshot(env):
    snap = json.dumps({"harness:fineract": 1, "harness:webapp": 2, "harness:traffic": 1, "harness-obs:obs": 1})
    p, st = env("resume.sh", ssm={"/harness/paused": "true", "/harness/desired-counts": snap},
                counts={k: 0 for k in SVC}, rds="stopped")
    assert p.returncode == 0, p.stderr
    assert st["counts"]["harness:webapp"] == 2
    assert st["ssm"]["/harness/paused"] == "false"
    assert "/harness/desired-counts" not in st["ssm"]


def test_resume_missing_service_in_snapshot_falls_back_to_one_but_keeps_explicit_zero(env):
    snap = json.dumps({"harness:fineract": 1, "harness:webapp": 0})
    p, st = env("resume.sh", ssm={"/harness/desired-counts": snap}, counts={k: 0 for k in SVC})
    assert p.returncode == 0, p.stderr
    assert st["counts"]["harness:webapp"] == 0
    assert st["counts"]["harness:traffic"] == 1


def test_resume_snapshot_read_error_aborts_instead_of_defaulting_to_one(env):
    p, st = env("resume.sh", ssm_errors={"/harness/desired-counts": "An error occurred (AccessDeniedException) ..."},
                counts={k: 0 for k in SVC})
    assert p.returncode != 0
    assert "AccessDenied" in p.stderr
    assert all(v == 0 for v in st["counts"].values())


def test_resume_wait_loop_is_bounded_and_shows_the_error(env):
    p, st = env("resume.sh", counts={k: 0 for k in SVC}, wait_fail=True)
    assert p.returncode != 0
    assert st["wait_calls"] <= 4
    assert "Max attempts exceeded" in p.stderr + p.stdout


def test_resume_does_not_put_credentials_on_the_command_line(env):
    # curl stub would show them in argv; assert the script source never uses -u user:pass
    src = (SCRIPTS / "resume.sh").read_text()
    assert 'curl -s -o /dev/null -w \'%{http_code}\' --max-time 20 -u' not in src
    assert '-u "$FUSER' not in src


TERMINAL = ["failed", "storage-full", "incompatible-parameters", "incompatible-restore", "inaccessible-encryption-credentials"]


@pytest.mark.parametrize("status", TERMINAL)
def test_pause_bails_out_immediately_on_a_terminal_db_state(env, status):
    p, st = env("pause.sh", rds=status)
    assert p.returncode != 0
    assert status in p.stderr
    assert st["rds_calls"] <= 3 if "rds_calls" in st else True
    assert not any(c[:2] == ["rds", "stop-db-instance"] for c in st["calls"])


@pytest.mark.parametrize("status", TERMINAL)
def test_resume_bails_out_immediately_on_a_terminal_db_state(env, status):
    p, st = env("resume.sh", rds=status, counts={k: 0 for k in SVC})
    assert p.returncode != 0
    assert status in p.stderr
    assert sum(c[:2] == ["rds", "describe-db-instances"] for c in st["calls"]) <= 2
    assert all(v == 0 for v in st["counts"].values())


def test_pause_wait_for_a_stuck_transitional_state_is_bounded(env):
    p, st = env("pause.sh", rds="modifying")
    assert p.returncode != 0
    assert "timed out" in p.stderr and "modifying" in p.stderr
    assert sum(c[:2] == ["rds", "describe-db-instances"] for c in st["calls"]) <= 60


def test_resume_wait_for_a_stuck_transitional_state_is_bounded(env):
    p, st = env("resume.sh", rds="stopping", counts={k: 0 for k in SVC})
    assert p.returncode != 0
    assert "timed out" in p.stderr and "stopping" in p.stderr
    assert sum(c[:2] == ["rds", "describe-db-instances"] for c in st["calls"]) <= 60


def test_pause_wait_db_stopped_is_bounded_when_the_db_never_stops(env):
    # stop is accepted, but the instance stays "available" forever (scripted sequence)
    p, st = env("pause.sh", rds_seq=["available"])
    assert p.returncode != 0
    assert "timed out" in p.stderr
    assert sum(c[:2] == ["rds", "describe-db-instances"] for c in st["calls"]) <= 80


def test_pause_still_succeeds_through_a_transitional_state(env):
    p, st = env("pause.sh", rds_seq=["backing-up", "backing-up", "available", "stopping", "stopped"])
    assert p.returncode == 0, p.stderr


def test_resume_still_succeeds_through_a_transitional_state(env):
    p, st = env("resume.sh", rds_seq=["stopping", "stopped", "available"], counts={k: 0 for k in SVC})
    assert p.returncode == 0, p.stderr


def test_pause_ssm_read_error_other_than_not_found_aborts_without_touching_anything(env):
    p, st = env("pause.sh", ssm_errors={"/harness/paused": "An error occurred (ThrottlingException) when calling GetParameter"})
    assert p.returncode != 0
    assert "ThrottlingException" in p.stderr
    assert "/harness/desired-counts" not in st["ssm"]
    assert all(v == 1 for v in st["counts"].values())
