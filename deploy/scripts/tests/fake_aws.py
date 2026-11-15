#!/usr/bin/env python3
"""Stub `aws` CLI for the pause/resume script tests. State lives in the JSON file named by $FAKE_STATE."""
import json
import os
import sys

path = os.environ["FAKE_STATE"]
st = json.load(open(path))
args = sys.argv[1:]
st.setdefault("calls", []).append(args)


def opt(name):
    return args[args.index(name) + 1] if name in args else None


def save():
    json.dump(st, open(path, "w"))


def out(v=""):
    save()
    print(v)
    sys.exit(0)


def fail(msg, code=254):
    save()
    print(msg, file=sys.stderr)
    sys.exit(code)


svc, op = args[0], args[1]
if svc == "cloudformation":
    out("harness-db")
if svc == "ssm" and op == "get-parameter":
    name = opt("--name")
    if name in st["ssm_errors"]:
        fail(st["ssm_errors"][name])
    if name not in st["ssm"]:
        fail("An error occurred (ParameterNotFound) when calling the GetParameter operation: not found")
    out(st["ssm"][name])
if svc == "ssm" and op == "put-parameter":
    st["ssm"][opt("--name")] = opt("--value")
    out()
if svc == "ssm" and op == "delete-parameter":
    st["ssm"].pop(opt("--name"), None)
    out()
if svc == "ecs" and op == "describe-services":
    key = opt("--cluster") + ":" + opt("--services")
    if "runningCount" in (opt("--query") or ""):
        seq = st.get("running_seq")  # optional scripted running counts, one per call; the last one repeats
        if seq:
            st["running_calls"] = st.get("running_calls", 0) + 1
            out(seq[min(st["running_calls"], len(seq)) - 1])
        out(st["counts"][key])
    out(st["counts"][key])
if svc == "ecs" and op == "update-service":
    key = opt("--cluster") + ":" + opt("--service")
    if st.get("fail_update_after") is not None:
        if st["fail_update_after"] == 0:
            fail("An error occurred (ThrottlingException)")
        st["fail_update_after"] -= 1
    st["counts"][key] = int(opt("--desired-count"))
    out()
if svc == "ecs" and op == "wait":
    st["wait_calls"] = st.get("wait_calls", 0) + 1
    if st.get("wait_fail"):
        fail("Waiter ServicesStable failed: Max attempts exceeded", 255)
    out()
if svc == "rds" and op == "describe-db-instances":
    seq = st.get("rds_seq")  # optional scripted statuses, one per call; the last one repeats
    if seq:
        st["rds_calls"] = st.get("rds_calls", 0) + 1
        out(seq[min(st["rds_calls"], len(seq)) - 1])
    out(st["rds"])
if svc == "rds" and op == "stop-db-instance":
    st["rds"] = "stopped"
    out()
if svc == "rds" and op == "start-db-instance":
    st["rds"] = "available"
    out()
if svc == "rds" and op == "wait":
    out()
if svc == "ecs" and op == "list-tasks":
    out(st.get("task_arn", "arn:aws:ecs:us-east-1:111111111111:task/harness/abc"))
if svc == "ssm" and op == "describe-instance-information":
    out(" ".join(st.get("managed_instances", ["mi-1"])))
if svc == "ssm" and op == "list-tags-for-resource":
    out(st.get("mi_task_arns", {}).get(opt("--resource-id"), "arn:aws:ecs:us-east-1:111111111111:task/harness/abc"))
if svc == "fis":
    if op == "list-experiment-templates":
        tpl = st.get("templates") or {"db-outage": "EXT-DB", "slowdown": "EXT-SLOW", "crash": "EXT-CRASH"}
        out(json.dumps({"experimentTemplates": [{"id": i, "tags": {"harness-scenario": n}} for n, i in tpl.items()]
                        + [{"id": "EXT-OTHER", "tags": {"Name": "rds-reboot"}}]}))
    if op == "list-experiments":
        out(json.dumps({"experiments": st.get("experiments", [])}))
    if op == "start-experiment":
        if st.get("fail_start"):
            fail("An error occurred (ValidationException) when calling the StartExperiment operation")
        st["started"] = {"template": opt("--experiment-template-id"), "tags": opt("--tags")}
        out(json.dumps({"experiment": {"id": "EXP-NEW", "startTime": "2026-11-15T10:00:00+00:00"}}))
    if op == "get-experiment":
        if "reason" in (opt("--query") or ""):
            out("Experiment completed")
        seq = st.get("exp_seq") or ["running", "completed"]
        st["exp_calls"] = st.get("exp_calls", 0) + 1
        v = seq[min(st["exp_calls"], len(seq)) - 1]
        if v == "ERR":
            fail("An error occurred (ThrottlingException) when calling the GetExperiment operation")
        out(v)
    if op == "stop-experiment":
        st.setdefault("stopped", []).append(opt("--id"))
        out("{}")
if svc == "sleep":
    out()
if svc == "secretsmanager":
    out(json.dumps({"username": "u", "password": "p"}))
fail("fake aws: unhandled " + " ".join(args), 2)
