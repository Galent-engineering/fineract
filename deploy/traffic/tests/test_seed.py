"""Seed security path: the read-only role, user upsert, and the credential fallback order."""
import base64
import json

import httpx
import pytest
import respx

from harness_traffic import seed as seed_mod
from tests.conftest import API, BASE


def _perm(code):
    return {"code": code, "grouping": "x", "entityName": "x", "actionName": code.split("_")[0], "selected": False}


PERMS = [
    _perm("READ_CLIENT"), _perm("READ_LOAN"), _perm("READ_OFFICE"),
    _perm("CREATE_CLIENT"), _perm("DELETE_LOAN"), _perm("ALL_FUNCTIONS"), _perm("APPROVE_LOAN"),
    _perm("READ_HOOK"), _perm("READ_EMAIL_CONFIGURATION"), _perm("READ_USER"), _perm("READ_ROLE"),
    _perm("READ_PASSWORD_PREFERENCES"),
]


@respx.mock
async def test_read_only_role_grants_only_business_reads_and_denies_everything_else_explicitly(client):
    respx.get(f"{API}/roles").mock(return_value=httpx.Response(200, json=[{"id": 3, "name": seed_mod.READ_ONLY_ROLE}]))
    respx.get(f"{API}/permissions").mock(return_value=httpx.Response(200, json=PERMS))
    put = respx.put(f"{API}/roles/3/permissions").mock(return_value=httpx.Response(200, json={"resourceId": 3}))

    role_id, n = await seed_mod.ensure_read_only_role(client)

    assert role_id == 3
    sent = json.loads(put.calls.last.request.content)["permissions"]
    granted = sorted(c for c, v in sent.items() if v is True)
    assert granted == ["READ_CLIENT", "READ_LOAN", "READ_OFFICE"]
    assert n == 3
    # every non-READ code and every excluded sensitive READ code is explicitly false (so a hand-added grant is revoked)
    for code in ["CREATE_CLIENT", "DELETE_LOAN", "ALL_FUNCTIONS", "APPROVE_LOAN",
                 "READ_HOOK", "READ_EMAIL_CONFIGURATION", "READ_USER", "READ_ROLE", "READ_PASSWORD_PREFERENCES"]:
        assert sent[code] is False


@respx.mock
async def test_read_only_role_is_created_when_missing(client):
    respx.get(f"{API}/roles").mock(return_value=httpx.Response(200, json=[]))
    post = respx.post(f"{API}/roles").mock(return_value=httpx.Response(200, json={"resourceId": 9}))
    respx.get(f"{API}/permissions").mock(return_value=httpx.Response(200, json=[_perm("READ_LOAN")]))
    put = respx.put(f"{API}/roles/9/permissions").mock(return_value=httpx.Response(200, json={}))
    role_id, _ = await seed_mod.ensure_read_only_role(client)
    assert role_id == 9 and post.called and put.called


@respx.mock
async def test_ensure_user_updates_existing_and_creates_missing(client):
    respx.get(f"{API}/users").mock(return_value=httpx.Response(200, json=[{"id": 4, "username": "harness_admin"}]))
    put = respx.put(f"{API}/users/4").mock(return_value=httpx.Response(200, json={"resourceId": 4}))
    post = respx.post(f"{API}/users").mock(return_value=httpx.Response(200, json={"resourceId": 7}))

    assert await seed_mod.ensure_user(client, "harness_admin", "pw", 1, 1, first="H", last="A") == 4
    assert json.loads(put.calls.last.request.content)["roles"] == [1]
    assert not post.called
    assert await seed_mod.ensure_user(client, "reliability_api", "pw2", 3, 1, first="R", last="A") == 7
    body = json.loads(post.calls.last.request.content)
    assert body["roles"] == [3] and body["username"] == "reliability_api"


def _basic(request: httpx.Request) -> tuple[str, str]:
    raw = base64.b64decode(request.headers["authorization"].split()[1]).decode()
    u, _, p = raw.partition(":")
    return u, p


@respx.mock
async def test_first_working_client_tries_admin_then_rotated_mifos_then_factory_password():
    tried: list[tuple[str, str]] = []

    def offices(request):
        tried.append(_basic(request))
        return httpx.Response(200, json=[{"id": 1}]) if _basic(request) == ("mifos", "password") else httpx.Response(401, json={})

    respx.get(f"{API}/offices").mock(side_effect=offices)
    c = await seed_mod._first_working_client(
        BASE, [("harness_admin", "a"), ("mifos", "rotated"), ("mifos", "password")]
    )
    assert tried == [("harness_admin", "a"), ("mifos", "rotated"), ("mifos", "password")]
    await c.aclose()


@respx.mock
async def test_first_working_client_stops_at_the_first_that_works():
    tried = []

    def offices(request):
        tried.append(_basic(request))
        return httpx.Response(200, json=[{"id": 1}])

    respx.get(f"{API}/offices").mock(side_effect=offices)
    c = await seed_mod._first_working_client(BASE, [("harness_admin", "a"), ("mifos", "rotated")])
    assert tried == [("harness_admin", "a")]
    await c.aclose()


@respx.mock
async def test_first_working_client_exits_when_nothing_works():
    respx.get(f"{API}/offices").mock(return_value=httpx.Response(401, json={}))
    with pytest.raises(SystemExit):
        await seed_mod._first_working_client(BASE, [("a", "b"), ("c", "d")])
