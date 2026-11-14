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
