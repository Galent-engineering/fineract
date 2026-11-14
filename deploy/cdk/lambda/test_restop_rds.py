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
        self.waiter = mock.Mock()
        self.rds.get_waiter.return_value = self.waiter

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


def test_starting_waits_for_available_then_stops():
    with Clients("true", status="starting") as c:
        order = []
        c.waiter.wait.side_effect = lambda **kw: order.append("wait")
        c.rds.stop_db_instance.side_effect = lambda **kw: order.append("stop")
        out = restop_rds.handler(event(), None)
    c.rds.get_waiter.assert_called_once_with("db_instance_available")
    kw = c.waiter.wait.call_args.kwargs
    assert kw["DBInstanceIdentifier"] == "harness-db"
    # bounded below the 15 min lambda timeout (900 s)
    assert kw["WaiterConfig"]["Delay"] * kw["WaiterConfig"]["MaxAttempts"] < 900
    assert order == ["wait", "stop"]
    assert out["action"] == "stopped"


def test_available_does_not_wait():
    with Clients("true", status="available") as c:
        restop_rds.handler(event(), None)
    c.waiter.wait.assert_not_called()


def test_paused_flag_flipped_during_wait_does_not_stop():
    with Clients("true", status="starting") as c:
        c.ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "true"}},
            {"Parameter": {"Value": "false"}},
        ]
        out = restop_rds.handler(event(), None)
    c.waiter.wait.assert_called_once()
    c.rds.stop_db_instance.assert_not_called()
    assert out["action"] == "not-paused"


def test_stop_exception_when_already_stopping_is_benign():
    with Clients("true", status="available") as c:
        c.rds.stop_db_instance.side_effect = Exception("InvalidDBInstanceState")
        c.rds.describe_db_instances.side_effect = [
            {"DBInstances": [{"DBInstanceStatus": "available"}]},
            {"DBInstances": [{"DBInstanceStatus": "stopping"}]},
        ]
        out = restop_rds.handler(event(), None)
    assert out["action"] == "already-stopped"


def test_stop_exception_otherwise_is_raised_so_eventbridge_retries():
    import pytest

    with Clients("true", status="available") as c:
        c.rds.stop_db_instance.side_effect = Exception("boom")
        with pytest.raises(Exception, match="boom"):
            restop_rds.handler(event(), None)


def test_waiter_timeout_is_raised():
    import pytest

    with Clients("true", status="starting") as c:
        c.waiter.wait.side_effect = Exception("WaiterError")
        with pytest.raises(Exception, match="WaiterError"):
            restop_rds.handler(event(), None)
    c.rds.stop_db_instance.assert_not_called()


def test_documented_rds_event_shape_is_handled():
    # Shape of an RDS event delivered via EventBridge (docs: "Amazon RDS event categories and event messages"
    # and the EventBridge RDS event examples); EventID and SourceIdentifier live under detail.
    real = {
        "version": "0",
        "source": "aws.rds",
        "detail-type": "RDS DB Instance Event",
        "resources": ["arn:aws:rds:us-east-1:111111111111:db:harness-db"],
        "detail": {
            "EventCategories": ["notification"],
            "SourceType": "DB_INSTANCE",
            "SourceArn": "arn:aws:rds:us-east-1:111111111111:db:harness-db",
            "Date": "2026-11-14T00:00:00.000Z",
            "Message": "DB instance started",
            "SourceIdentifier": "harness-db",
            "EventID": "RDS-EVENT-0154",
        },
    }
    with Clients("true", status="starting") as c:
        out = restop_rds.handler(real, None)
    assert out["action"] == "stopped"
    c.waiter.wait.assert_called_once()
