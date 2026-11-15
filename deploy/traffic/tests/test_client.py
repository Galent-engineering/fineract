import httpx
import pytest
import respx

from harness_traffic.client import FineractClient, FineractError
from tests.conftest import API, BASE


@respx.mock
async def test_get_and_post_send_tenant_header_and_basic_auth():
    route = respx.post(f"{API}/clients").mock(return_value=httpx.Response(200, json={"clientId": 7}))
    c = FineractClient(BASE, "user", "pw")
    assert await c.post("/clients", {"a": 1}) == {"clientId": 7}
    req = route.calls[0].request
    assert req.headers["Fineract-Platform-TenantId"] == "default"
    assert req.headers["Authorization"].startswith("Basic ")


@respx.mock
async def test_http_error_raises_fineract_error_with_status_and_body(client):
    respx.get(f"{API}/loans/1").mock(return_value=httpx.Response(404, json={"developerMessage": "nope"}))
    with pytest.raises(FineractError) as ei:
        await client.get("/loans/1")
    assert ei.value.status == 404
    assert ei.value.body == {"developerMessage": "nope"}


@respx.mock
async def test_connection_failure_is_status_zero(client):
    respx.get(f"{API}/offices").mock(side_effect=httpx.ConnectError("boom"))
    with pytest.raises(FineractError) as ei:
        await client.get("/offices")
    assert ei.value.status == 0


import asyncio  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402
import respx  # noqa: E402

from harness_traffic.client import FineractClient, FineractError  # noqa: E402


@respx.mock
async def test_a_slow_response_becomes_status_0_timeout():
    async def hang(request):
        await asyncio.sleep(1)
        return httpx.Response(200, json={})

    respx.get("https://f.test/fineract-provider/api/v1/x").mock(side_effect=hang)
    c = FineractClient("https://f.test", "u", "p", timeout=0.05)
    with pytest.raises(FineractError) as ei:
        await c.get("/x")
    assert ei.value.status == 0 and str(ei.value) == "timeout"


@respx.mock
async def test_httpx_timeout_exceptions_are_also_status_0_timeout():
    respx.get("https://f.test/fineract-provider/api/v1/x").mock(side_effect=httpx.ReadTimeout("slow"))
    c = FineractClient("https://f.test", "u", "p")
    with pytest.raises(FineractError) as ei:
        await c.get("/x")
    assert ei.value.status == 0 and ei.value.body == {"error": "timeout"}


def test_traffic_uses_a_15_second_request_timeout():
    from harness_traffic import run as run_mod

    assert run_mod.TRAFFIC_TIMEOUT_S == 15.0
