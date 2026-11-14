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
    out(st["counts"][opt("--cluster") + ":" + opt("--services")])
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
    out(st["rds"])
if svc == "rds" and op == "stop-db-instance":
    st["rds"] = "stopped"
    out()
if svc == "rds" and op == "start-db-instance":
    st["rds"] = "available"
    out()
if svc == "rds" and op == "wait":
    out()
if svc == "secretsmanager":
    out(json.dumps({"username": "u", "password": "p"}))
fail("fake aws: unhandled " + " ".join(args), 2)
