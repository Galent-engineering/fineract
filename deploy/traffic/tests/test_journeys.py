import httpx
import respx

from harness_traffic.journeys import inject_error, inject_slow, run_loan_journey, run_savings_journey
from harness_traffic.seed import seed
from tests.conftest import API


def _mock_seed_existing():
    respx.get(f"{API}/offices").mock(return_value=httpx.Response(200, json=[{"id": 1}]))
    respx.get(f"{API}/staff").mock(return_value=httpx.Response(200, json=[{"id": 2, "externalId": "harness-staff-1"}]))
    respx.get(f"{API}/loanproducts").mock(return_value=httpx.Response(200, json=[{"id": 3, "name": "harness-standard-loan"}]))
    respx.get(f"{API}/savingsproducts").mock(return_value=httpx.Response(200, json=[{"id": 4, "name": "harness-standard-savings"}]))
    respx.get(f"{API}/paymenttypes").mock(return_value=httpx.Response(200, json=[{"id": 5, "name": "harness-cash"}]))
    respx.get(f"{API}/clients").mock(return_value=httpx.Response(200, json={"pageItems": [{"id": 10}]}))


@respx.mock
async def test_seed_is_idempotent(client):
    _mock_seed_existing()
    creates = [
        respx.post(f"{API}/{p}").mock(return_value=httpx.Response(200, json={"resourceId": 99, "clientId": 99}))
        for p in ("staff", "loanproducts", "savingsproducts", "paymenttypes", "clients")
    ]
    result = await seed(client)
    assert (result.office_id, result.staff_id, result.loan_product_id, result.savings_product_id) == (1, 2, 3, 4)
    assert result.payment_type_id == 5
    assert len(result.client_ids) == 5
    assert all(not r.called for r in creates)


@respx.mock
async def test_seed_creates_missing(client):
    respx.get(f"{API}/offices").mock(return_value=httpx.Response(200, json=[{"id": 1}]))
    for p in ("staff", "loanproducts", "savingsproducts", "paymenttypes"):
        respx.get(f"{API}/{p}").mock(return_value=httpx.Response(200, json=[]))
        respx.post(f"{API}/{p}").mock(return_value=httpx.Response(200, json={"resourceId": 8}))
    respx.get(f"{API}/clients").mock(return_value=httpx.Response(200, json={"pageItems": []}))
    respx.post(f"{API}/clients").mock(return_value=httpx.Response(200, json={"clientId": 9}))
    result = await seed(client)
    assert result.staff_id == 8 and result.client_ids == [9] * 5


@respx.mock
async def test_loan_journey_calls_in_order(client, seed_result):
    respx.post(f"{API}/clients").mock(return_value=httpx.Response(200, json={"clientId": 50}))
    respx.post(f"{API}/loans").mock(return_value=httpx.Response(200, json={"loanId": 60}))
    respx.post(url__regex=rf"{API}/loans/60.*").mock(return_value=httpx.Response(200, json={"loanId": 60}))
    out = await run_loan_journey(client, seed_result)
    assert out.ok
    assert [(c.request.method, c.request.url.path.removeprefix("/fineract-provider/api/v1"), c.request.url.query.decode())
            for c in respx.calls] == [
        ("POST", "/clients", ""),
        ("POST", "/loans", ""),
        ("POST", "/loans/60", "command=approve"),
        ("POST", "/loans/60", "command=disburse"),
        ("POST", "/loans/60/transactions", "command=repayment"),
    ]
    assert out.steps == ["create_client", "submit_loan", "approve", "disburse", "repayment"]


@respx.mock
async def test_savings_journey_calls_in_order(client, seed_result):
    respx.post(f"{API}/savingsaccounts").mock(return_value=httpx.Response(200, json={"savingsId": 70}))
    respx.post(url__regex=rf"{API}/savingsaccounts/70.*").mock(return_value=httpx.Response(200, json={}))
    out = await run_savings_journey(client, seed_result)
    assert out.ok
    assert out.steps == ["create_account", "approve", "activate", "deposit", "withdrawal"]


@respx.mock
async def test_journey_records_error_instead_of_raising(client, seed_result):
    respx.post(f"{API}/clients").mock(return_value=httpx.Response(500, json={"error": "x"}))
    out = await run_loan_journey(client, seed_result)
    assert not out.ok and out.status == 500 and out.steps == []


@respx.mock
async def test_injected_error_is_logged_not_raised(client, capsys):
    respx.post(f"{API}/loans/999999999/transactions").mock(return_value=httpx.Response(404, json={"developerMessage": "no loan"}))
    out = await inject_error(client)
    assert out.injected is True and out.status == 404 and out.error
    assert '"injected": true' in capsys.readouterr().out


@respx.mock
async def test_injected_slow_calls_a_heavy_report_and_logs_slow(client, capsys):
    route = respx.get(f"{API}/runreports/Client Listing").mock(return_value=httpx.Response(200, json=[]))
    out = await inject_slow(client)
    assert route.called and out.ok and out.injected == "slow"
    assert '"injected": "slow"' in capsys.readouterr().out
