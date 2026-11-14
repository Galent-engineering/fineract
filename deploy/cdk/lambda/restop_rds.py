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


def _clients():
    return boto3.client("ssm"), boto3.client("rds")


def handler(event, context):
    instance = os.environ["DB_INSTANCE_ID"]
    detail = event.get("detail") or {}
    if detail.get("EventID") != EVENT_ID or detail.get("SourceIdentifier") != instance:
        log.info("ignored event %s for %s", detail.get("EventID"), detail.get("SourceIdentifier"))
        return {"action": "ignored"}

    ssm, rds = _clients()
    try:
        paused = ssm.get_parameter(Name=os.environ["PAUSED_PARAM"])["Parameter"]["Value"]
    except Exception as exc:  # missing parameter means "not paused": never stop on doubt
        log.warning("cannot read paused parameter: %s", exc)
        paused = "false"
    if paused != "true":
        log.info("harness not paused; leaving %s running", instance)
        return {"action": "not-paused"}

    status = rds.describe_db_instances(DBInstanceIdentifier=instance)["DBInstances"][0]["DBInstanceStatus"]
    if status in ("stopped", "stopping"):
        log.info("%s already %s", instance, status)
        return {"action": "already-stopped", "status": status}

    rds.stop_db_instance(DBInstanceIdentifier=instance)
    log.info("re-stopped %s (was %s)", instance, status)
    return {"action": "stopped", "status": status}
