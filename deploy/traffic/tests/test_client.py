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
