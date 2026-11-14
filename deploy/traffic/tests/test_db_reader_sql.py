"""db_reader.sql is applied by the db-reader-grant one-off task; pin the guard rails it must set on the role."""
import re
from pathlib import Path

SQL = (Path(__file__).parent.parent / "harness_traffic" / "db_reader.sql").read_text()


def test_role_is_read_only_by_default_with_timeout_and_connection_limit():
    assert re.search(r"ALTER ROLE reliability_reader\s+SET default_transaction_read_only\s*=\s*on", SQL, re.I)
    assert re.search(r"ALTER ROLE reliability_reader\s+SET statement_timeout\s*=\s*'30s'", SQL, re.I)
    assert re.search(r"ALTER ROLE reliability_reader\s+(WITH\s+)?CONNECTION LIMIT 5", SQL, re.I)


def test_no_write_grants():
    assert not re.search(r"GRANT\s+(INSERT|UPDATE|DELETE|TRUNCATE|ALL|CREATE)", SQL, re.I)
