"""Re-stop the harness RDS instance after RDS auto-starts it (7-day maximum stop time).

Triggered by RDS-EVENT-0154. Stops the instance again only while /harness/paused == "true".
IAM is least-privilege: ssm:GetParameter on the paused parameter, rds:StopDBInstance and
rds:DescribeDBInstances on the harness instance ARN only.
"""
import logging
import os

import boto3

log = logging.getLogger()
log.setLevel(logging.INFO)

EVENT_ID = "RDS-EVENT-0154"
WAIT_DELAY_S = 30
WAIT_MAX_ATTEMPTS = 26  # 13 min, under the 900 s Lambda timeout


def _is_paused(ssm):
    try:
        return ssm.get_parameter(Name=os.environ["PAUSED_PARAM"])["Parameter"]["Value"] == "true"
    except Exception as exc:  # missing parameter means "not paused": never stop on doubt
        log.warning("cannot read paused parameter: %s", exc)
        return False


def _status(rds, instance):
    return rds.describe_db_instances(DBInstanceIdentifier=instance)["DBInstances"][0]["DBInstanceStatus"]


def _clients():
    return boto3.client("ssm"), boto3.client("rds")


def handler(event, context):
    instance = os.environ["DB_INSTANCE_ID"]
    detail = event.get("detail") or {}
    if detail.get("EventID") != EVENT_ID or detail.get("SourceIdentifier") != instance:
        log.info("ignored event %s for %s", detail.get("EventID"), detail.get("SourceIdentifier"))
        return {"action": "ignored"}

    ssm, rds = _clients()
    if not _is_paused(ssm):
        log.info("harness not paused; leaving %s running", instance)
        return {"action": "not-paused"}

    status = _status(rds, instance)
    if status in ("stopped", "stopping"):
        log.info("%s already %s", instance, status)
        return {"action": "already-stopped", "status": status}

    if status != "available":
        # RDS-EVENT-0154 arrives while the instance is still "starting"; StopDBInstance needs "available".
        # The wait is bounded below the 15 min Lambda timeout; a waiter failure propagates so EventBridge retries.
        log.info("%s is %s; waiting for available", instance, status)
        rds.get_waiter("db_instance_available").wait(
            DBInstanceIdentifier=instance,
            WaiterConfig={"Delay": WAIT_DELAY_S, "MaxAttempts": WAIT_MAX_ATTEMPTS},
        )
        if not _is_paused(ssm):  # resume.sh may have run while we waited
            log.info("harness resumed while waiting; leaving %s running", instance)
            return {"action": "not-paused"}

    try:
        rds.stop_db_instance(DBInstanceIdentifier=instance)
    except Exception:
        now = _status(rds, instance)
        if now in ("stopped", "stopping"):
            log.info("%s already %s after a failed stop call", instance, now)
            return {"action": "already-stopped", "status": now}
        raise
    log.info("re-stopped %s (was %s)", instance, status)
    return {"action": "stopped", "status": status}
