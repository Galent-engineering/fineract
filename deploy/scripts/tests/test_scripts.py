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

    def run(script, *args, **st):
        base = {"ssm": {}, "ssm_errors": {}, "counts": {k: 1 for k in SVC}, "rds": "available"}
        base.update(st)
        state.write_text(json.dumps(base))
        p = subprocess.run(["bash", str(SCRIPTS / script), *args], env=e, capture_output=True, text=True, timeout=60)
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


# ---- demo.sh ----------------------------------------------------------------------------------------------------------

def live(status="running", tpl="EXT-DB", start="2026-11-15T10:00:00+00:00", id_="EXP-OLD", name="db-outage"):
    """tpl=EXT-OTHER makes a foreign (untagged) experiment; scenario experiments carry the harness-scenario tag."""
    e = {"id": id_, "experimentTemplateId": tpl, "state": {"status": status}, "startTime": start}
    e["tags"] = {} if tpl == "EXT-OTHER" else {"harness-scenario": name}
    return e


def test_demo_on_and_off_set_the_rate_and_print_before_after(env):
    p, st = env("demo.sh", "on", ssm={"/harness/traffic/rate_per_min": "6"})
    assert p.returncode == 0, p.stderr
    assert st["ssm"]["/harness/traffic/rate_per_min"] == "60"
    assert "6 -> 60" in p.stdout
    p, st = env("demo.sh", "off", ssm={"/harness/traffic/rate_per_min": "60"})
    assert st["ssm"]["/harness/traffic/rate_per_min"] == "6"
    assert "60 -> 6" in p.stdout


def test_demo_rejects_unknown_commands_and_missing_command(env):
    assert env("demo.sh")[0].returncode == 2
    assert env("demo.sh", "explode")[0].returncode == 2


def test_demo_db_outage_starts_the_tagged_template_and_waits_for_the_end(env):
    p, st = env("demo.sh", "db-outage", exp_seq=["running", "running", "completed"])
    assert p.returncode == 0, p.stderr
    assert st["started"]["template"] == "EXT-DB"
    assert st["started"]["tags"] == "harness-scenario=db-outage"
    assert "EXP-NEW" in p.stdout and "expected end" in p.stdout and "5xx" in p.stdout
    assert "completed" in p.stdout.splitlines()[-1]


def test_demo_picks_the_template_by_scenario_tag(env):
    for name, tid in [("slowdown", "EXT-SLOW"), ("crash", "EXT-CRASH")]:
        p, st = env("demo.sh", name, exp_seq=["completed"])
        assert p.returncode == 0, p.stderr
        assert st["started"]["template"] == tid


def test_demo_refuses_when_paused(env):
    p, st = env("demo.sh", "db-outage", counts={k: 0 for k in SVC})
    assert p.returncode == 1
    assert "paused" in p.stderr
    assert "started" not in st


def test_demo_refuses_while_another_scenario_runs(env):
    p, st = env("demo.sh", "slowdown", experiments=[live("running")])
    assert p.returncode == 1
    assert "already running" in p.stderr and "EXP-OLD" in p.stderr
    assert "started" not in st


def test_demo_finished_experiments_do_not_block_a_new_one(env):
    p, st = env("demo.sh", "slowdown", experiments=[live("completed")], exp_seq=["completed"])
    assert p.returncode == 0, p.stderr


def test_demo_a_foreign_experiment_does_not_block(env):
    p, st = env("demo.sh", "slowdown", experiments=[live("running", tpl="EXT-OTHER")], exp_seq=["completed"])
    assert p.returncode == 0, p.stderr


def test_demo_missing_template_is_a_clear_failure(env):
    p, st = env("demo.sh", "crash", templates={"slowdown": "EXT-SLOW"})
    assert p.returncode == 1
    assert "harness-scenario=crash" in p.stderr


def test_demo_wait_for_the_experiment_is_bounded(env):
    p, st = env("demo.sh", "db-outage", exp_seq=["running"])
    assert p.returncode == 1
    assert "still 'running'" in p.stderr
    assert st["exp_calls"] <= 61


def test_demo_failed_experiment_exits_nonzero(env):
    p, st = env("demo.sh", "slowdown", exp_seq=["failed"])
    assert p.returncode == 1
    assert "did not run to completion" in p.stderr


def test_demo_crash_waits_for_the_replacement_task(env):
    p, st = env("demo.sh", "crash", exp_seq=["completed"], running_seq=["1", "0", "0", "1"])
    assert p.returncode == 0, p.stderr
    assert "fineract 1 running / 1 desired" in p.stdout


def test_demo_final_wait_for_fineract_is_bounded(env):
    p, st = env("demo.sh", "crash", exp_seq=["completed"], running_seq=["1", "0"])
    assert p.returncode == 1
    assert "still 0/1" in p.stderr
    assert st["running_calls"] <= 62


def test_demo_status_shows_rate_counts_and_experiments(env):
    p, st = env("demo.sh", "status", ssm={"/harness/traffic/rate_per_min": "60"},
                experiments=[live("running"), live("completed", tpl="EXT-SLOW", start="2026-11-14T10:00:00+00:00", id_="EXP-PREV", name="slowdown")])
    assert p.returncode == 0, p.stderr
    out = p.stdout
    assert "traffic rate per minute: 60" in out
    assert "fineract: 1 running / 1 desired" in out
    assert "EXP-OLD running" in out and "EXP-PREV completed" in out and "db-outage" in out


def test_demo_stop_stops_only_active_scenario_experiments(env):
    p, st = env("demo.sh", "stop", experiments=[live("running"), live("completed", id_="EXP-DONE"),
                                               live("running", tpl="EXT-OTHER", id_="EXP-FOREIGN")])
    assert p.returncode == 0, p.stderr
    assert st["stopped"] == ["EXP-OLD"]


def test_demo_stop_with_nothing_running_is_a_noop(env):
    p, st = env("demo.sh", "stop")
    assert p.returncode == 0
    assert "stopped" not in st


def test_demo_accepts_profile_flag(env):
    p, st = env("demo.sh", "--profile", "other", "status")
    assert p.returncode == 0, p.stderr


def test_demo_finds_a_running_experiment_by_its_tag_even_if_its_template_was_replaced(env):
    p, st = env("demo.sh", "slowdown", experiments=[live("running", tpl="EXT-GONE")])
    assert p.returncode == 1
    assert "already running" in p.stderr
    p, st = env("demo.sh", "stop", experiments=[live("running", tpl="EXT-GONE")])
    assert st["stopped"] == ["EXP-OLD"]


def test_demo_refuses_network_scenarios_until_the_fault_agent_registered(env):
    for name in ("db-outage", "slowdown"):
        p, st = env("demo.sh", name, mi_task_arns={"mi-1": "arn:aws:ecs:us-east-1:111111111111:task/harness/OLDTASK"})
        assert p.returncode == 1
        assert "fault agent still registering" in p.stderr and "retry in a minute" in p.stderr
        assert "started" not in st
    p, st = env("demo.sh", "slowdown", managed_instances=[])
    assert p.returncode == 1 and "fault agent still registering" in p.stderr


def test_demo_crash_does_not_need_the_fault_agent(env):
    p, st = env("demo.sh", "crash", managed_instances=[], exp_seq=["completed"])
    assert p.returncode == 0, p.stderr


def test_demo_tolerates_two_failed_polls_but_not_three(env):
    p, st = env("demo.sh", "slowdown", exp_seq=["ERR", "ERR", "completed"])
    assert p.returncode == 0, p.stderr
    p, st = env("demo.sh", "slowdown", exp_seq=["ERR"])
    assert p.returncode == 1
    assert "cannot read experiment" in p.stderr
    assert st["exp_calls"] == 3


def test_demo_slowdown_hint_matches_the_readme(env):
    p, st = env("demo.sh", "slowdown", exp_seq=["completed"])
    assert "about 200 ms added per database round trip" in p.stdout
