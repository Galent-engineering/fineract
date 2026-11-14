"""Tests for restop_rds.handler with a stubbed boto3 (no AWS calls)."""
import os
from unittest import mock

os.environ["DB_INSTANCE_ID"] = "harness-db"
os.environ["PAUSED_PARAM"] = "/harness/paused"

import restop_rds  # noqa: E402


def event(instance="harness-db", event_id="RDS-EVENT-0154"):
    return {"source": "aws.rds", "detail": {"EventID": event_id, "SourceIdentifier": instance}}


class Clients:
    def __init__(self, paused="true", status="available"):
        self.ssm = mock.Mock()
        self.ssm.get_parameter.return_value = {"Parameter": {"Value": paused}}
        self.rds = mock.Mock()
        self.rds.describe_db_instances.return_value = {"DBInstances": [{"DBInstanceStatus": status}]}

    def __enter__(self):
        self.p = mock.patch.object(restop_rds, "_clients", return_value=(self.ssm, self.rds))
        self.p.start()
        return self

    def __exit__(self, *a):
        self.p.stop()


def test_paused_true_stops_once():
    with Clients("true") as c:
        out = restop_rds.handler(event(), None)
    c.rds.stop_db_instance.assert_called_once_with(DBInstanceIdentifier="harness-db")
    assert out["action"] == "stopped"


def test_paused_false_does_not_stop():
    with Clients("false") as c:
        out = restop_rds.handler(event(), None)
    c.rds.stop_db_instance.assert_not_called()
    assert out["action"] == "not-paused"


def test_other_instance_ignored():
    with Clients("true") as c:
        out = restop_rds.handler(event(instance="langfuse"), None)
    c.rds.stop_db_instance.assert_not_called()
    c.ssm.get_parameter.assert_not_called()
    assert out["action"] == "ignored"


def test_other_event_id_ignored():
    with Clients("true") as c:
        restop_rds.handler(event(event_id="RDS-EVENT-0005"), None)
    c.rds.stop_db_instance.assert_not_called()


def test_already_stopped_is_noop():
    with Clients("true", status="stopped") as c:
        out = restop_rds.handler(event(), None)
    c.rds.stop_db_instance.assert_not_called()
    assert out["action"] == "already-stopped"


def test_missing_param_treated_as_not_paused():
    with Clients() as c:
        c.ssm.get_parameter.side_effect = Exception("ParameterNotFound")
        out = restop_rds.handler(event(), None)
    c.rds.stop_db_instance.assert_not_called()
    assert out["action"] == "not-paused"
