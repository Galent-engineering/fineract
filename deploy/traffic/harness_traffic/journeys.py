"""Loan and savings journeys, plus error and latency injection. All calls go through Fineract API v1."""

from __future__ import annotations

import json
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from .client import FineractClient, FineractError, date_fields, fmt_date
from .seed import SeedResult

SLOW_REPORT = "Client Listing"  # "Active Loans - Details" 403s on Postgres (BadSqlGrammar); this one scales with client count


@dataclass
class JourneyOutcome:
    journey: str
    steps: list[str] = field(default_factory=list)
    error: str | None = None
    status: int | None = None
    injected: bool | str = False
    ids: dict[str, int] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.error is None


def log(event: str, **kw: Any) -> None:
    print(json.dumps({"event": event, **kw}), flush=True)


async def _step(
    client: FineractClient,
    out: JourneyOutcome,
    step: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    t0 = time.monotonic()
    status = 200
    try:
        if method == "GET":
            resp = await client.get(path, params)
        else:
            resp = await client.post(path, payload)
        return resp
    except FineractError as exc:
        status = exc.status
        raise
    finally:
        log(
            "step",
            journey=out.journey,
            step=step,
            status=status,
            latency_ms=round((time.monotonic() - t0) * 1000),
            injected=out.injected,
        )


async def run_loan_journey(client: FineractClient, seed: SeedResult) -> JourneyOutcome:
    out = JourneyOutcome("loan")
    d, today = date_fields(), fmt_date()
    try:
        c = await _step(
            client, out, "create_client", "POST", "/clients",
            {**d, "officeId": seed.office_id, "firstname": "Harness", "lastname": f"Customer {uuid.uuid4().hex[:8]}",
             "active": True, "activationDate": today, "legalFormId": 1, "externalId": f"harness-{uuid.uuid4().hex[:12]}"},
        )
        out.steps.append("create_client")
        out.ids["client"] = int(c["clientId"])
        loan = await _step(
            client, out, "submit_loan", "POST", "/loans",
            {**d, "clientId": out.ids["client"], "productId": seed.loan_product_id, "loanType": "individual",
             "principal": random.choice([1000, 2500, 5000, 7500]), "loanTermFrequency": 12, "loanTermFrequencyType": 2,
             "numberOfRepayments": 12, "repaymentEvery": 1, "repaymentFrequencyType": 2, "interestRatePerPeriod": 12,
             "interestRateFrequencyType": 3, "amortizationType": 1, "interestType": 0, "interestCalculationPeriodType": 1,
             "transactionProcessingStrategyCode": "mifos-standard-strategy", "loanOfficerId": seed.staff_id,
             "expectedDisbursementDate": today, "submittedOnDate": today},
        )
        out.steps.append("submit_loan")
        lid = out.ids["loan"] = int(loan["loanId"])
        await _step(client, out, "approve", "POST", f"/loans/{lid}?command=approve", {**d, "approvedOnDate": today})
        out.steps.append("approve")
        await _step(client, out, "disburse", "POST", f"/loans/{lid}?command=disburse", {**d, "actualDisbursementDate": today})
        out.steps.append("disburse")
        await _step(client, out, "repayment", "POST", f"/loans/{lid}/transactions?command=repayment",
                    {**d, "transactionDate": today, "transactionAmount": 100})
        out.steps.append("repayment")
    except FineractError as exc:
        out.error, out.status = str(exc), exc.status
    return out


async def run_repayment(client: FineractClient, loan_id: int) -> JourneyOutcome:
    """A later repayment on an older loan."""
    out = JourneyOutcome("repayment", ids={"loan": loan_id})
    try:
        await _step(client, out, "repayment", "POST", f"/loans/{loan_id}/transactions?command=repayment",
                    {**date_fields(), "transactionDate": fmt_date(), "transactionAmount": 50})
        out.steps.append("repayment")
    except FineractError as exc:
        out.error, out.status = str(exc), exc.status
    return out


async def run_savings_journey(client: FineractClient, seed: SeedResult) -> JourneyOutcome:
    out = JourneyOutcome("savings")
    d, today = date_fields(), fmt_date()
    try:
        sa = await _step(
            client, out, "create_account", "POST", "/savingsaccounts",
            {**d, "clientId": random.choice(seed.client_ids), "productId": seed.savings_product_id, "submittedOnDate": today},
        )
        out.steps.append("create_account")
        sid = out.ids["savings"] = int(sa["savingsId"])
        await _step(client, out, "approve", "POST", f"/savingsaccounts/{sid}?command=approve", {**d, "approvedOnDate": today})
        out.steps.append("approve")
        await _step(client, out, "activate", "POST", f"/savingsaccounts/{sid}?command=activate", {**d, "activatedOnDate": today})
        out.steps.append("activate")
        tx = {**d, "transactionDate": today, "paymentTypeId": seed.payment_type_id}
        await _step(client, out, "deposit", "POST", f"/savingsaccounts/{sid}/transactions?command=deposit",
                    {**tx, "transactionAmount": 500})
        out.steps.append("deposit")
        await _step(client, out, "withdrawal", "POST", f"/savingsaccounts/{sid}/transactions?command=withdrawal",
                    {**tx, "transactionAmount": 50})
        out.steps.append("withdrawal")
    except FineractError as exc:
        out.error, out.status = str(exc), exc.status
    return out


async def inject_error(client: FineractClient) -> JourneyOutcome:
    """Deliberately invalid request: a repayment on a loan id that cannot exist (a 4xx). Logged, never raised."""
    out = JourneyOutcome("injected_error", injected=True)
    try:
        await _step(client, out, "repayment_bad_loan", "POST", "/loans/999999999/transactions?command=repayment",
                    {**date_fields(), "transactionDate": fmt_date(), "transactionAmount": 1})
        out.steps.append("repayment_bad_loan")
    except FineractError as exc:
        out.error, out.status = str(exc), exc.status
    return out


async def inject_slow(client: FineractClient) -> JourneyOutcome:
    """A heavy server-side read (full-table report) that creates genuine Fineract/DB latency."""
    out = JourneyOutcome("injected_slow", injected="slow")
    try:
        await _step(client, out, "heavy_report", "GET", f"/runreports/{SLOW_REPORT}",
                    params={"R_officeId": 1, "genericResultSet": "false"})
        out.steps.append("heavy_report")
    except FineractError as exc:
        out.error, out.status = str(exc), exc.status
    return out
