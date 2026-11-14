"""Idempotent reference data, user/role provisioning and Loan COB job activation."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Any

from .client import FineractClient, FineractError, date_fields, fmt_date, rows

PREFIX = "harness-"
SEED_CLIENT_COUNT = 5
READ_ONLY_ROLE = "Reliability Read Only"
# Sensitive reads the connector does not need (business reads only): hooks, SMTP settings, user/role directories,
# password policy. Sent as explicit False so a re-seed also revokes anything granted by hand.
EXCLUDED_READ_CODES = frozenset(
    {"READ_HOOK", "READ_EMAIL_CONFIGURATION", "READ_USER", "READ_ROLE", "READ_PASSWORD_PREFERENCES"}
)
LOAN_COB_CRON = "0 30 0 * * ?"  # UTC, 00:30 daily


@dataclass
class SeedResult:
    office_id: int
    staff_id: int
    loan_product_id: int
    savings_product_id: int
    payment_type_id: int
    client_ids: list[int] = field(default_factory=list)


def _log(event: str, **kw: Any) -> None:
    print(json.dumps({"event": event, **kw}), flush=True)


LOAN_PRODUCT = {
    "name": "harness-standard-loan",
    "shortName": "HSL1",
    "currencyCode": "USD",
    "digitsAfterDecimal": 2,
    "inMultiplesOf": 0,
    "principal": 10000,
    "minPrincipal": 100,
    "maxPrincipal": 100000,
    "numberOfRepayments": 12,
    "minNumberOfRepayments": 1,
    "maxNumberOfRepayments": 60,
    "repaymentEvery": 1,
    "repaymentFrequencyType": 2,
    "interestRatePerPeriod": 12,
    "minInterestRatePerPeriod": 0,
    "maxInterestRatePerPeriod": 30,
    "interestRateFrequencyType": 3,
    "amortizationType": 1,
    "interestType": 0,
    "interestCalculationPeriodType": 1,
    "transactionProcessingStrategyCode": "mifos-standard-strategy",
    "accountingRule": 1,
    "isInterestRecalculationEnabled": False,
    "daysInMonthType": 1,
    "daysInYearType": 1,
}

SAVINGS_PRODUCT = {  # savings products reject dateFormat
    "locale": "en",
    "name": "harness-standard-savings",
    "shortName": "HSS1",
    "currencyCode": "USD",
    "digitsAfterDecimal": 2,
    "inMultiplesOf": 0,
    "nominalAnnualInterestRate": 3,
    "interestCompoundingPeriodType": 1,
    "interestPostingPeriodType": 4,
    "interestCalculationType": 1,
    "interestCalculationDaysInYearType": 365,
    "accountingRule": 1,
}


def _has_prefix(row: dict[str, Any], key: str) -> bool:
    return str(row.get(key) or "").startswith(PREFIX)


async def seed(client: FineractClient) -> SeedResult:
    """Look things up by the `harness-` prefix first; create only what is missing."""
    offices = rows(await client.get("/offices"))
    office_id = int(offices[0]["id"])

    staff = [s for s in rows(await client.get("/staff")) if _has_prefix(s, "externalId")]
    if staff:
        staff_id = int(staff[0]["id"])
    else:
        r = await client.post(
            "/staff",
            {
                **date_fields(),
                "officeId": office_id,
                "firstname": "Harness",
                "lastname": "Loan Officer",
                "isLoanOfficer": True,
                "isActive": True,
                "joiningDate": fmt_date(),
                "externalId": f"{PREFIX}staff-1",
            },
        )
        staff_id = int(r["resourceId"])

    loan_products = [p for p in rows(await client.get("/loanproducts")) if _has_prefix(p, "name")]
    if loan_products:
        loan_product_id = int(loan_products[0]["id"])
    else:
        loan_product_id = int((await client.post("/loanproducts", {**date_fields(), **LOAN_PRODUCT}))["resourceId"])

    sav_products = [p for p in rows(await client.get("/savingsproducts")) if _has_prefix(p, "name")]
    if sav_products:
        savings_product_id = int(sav_products[0]["id"])
    else:
        savings_product_id = int((await client.post("/savingsproducts", SAVINGS_PRODUCT))["resourceId"])

    pay_types = [p for p in rows(await client.get("/paymenttypes")) if _has_prefix(p, "name")]
    if pay_types:
        payment_type_id = int(pay_types[0]["id"])
    else:
        r = await client.post(
            "/paymenttypes",
            {"name": f"{PREFIX}cash", "description": "harness cash", "isCashPayment": True, "position": 4},
        )
        payment_type_id = int(r["resourceId"])

    client_ids: list[int] = []
    for n in range(1, SEED_CLIENT_COUNT + 1):
        ext = f"{PREFIX}seed-client-{n}"
        found = rows(await client.get("/clients", {"externalId": ext}))
        if found:
            client_ids.append(int(found[0]["id"]))
            continue
        r = await client.post(
            "/clients",
            {
                **date_fields(),
                "officeId": office_id,
                "firstname": "Harness",
                "lastname": f"Seed {n}",
                "active": True,
                "activationDate": fmt_date(),
                "legalFormId": 1,
                "externalId": ext,
            },
        )
        client_ids.append(int(r["clientId"]))

    return SeedResult(office_id, staff_id, loan_product_id, savings_product_id, payment_type_id, client_ids)


# ---------------------------------------------------------------- users, roles, jobs


async def relax_password_policy(client: FineractClient) -> None:
    """Fineract's default `strong` policy demands a special character; the generated secrets are alphanumeric
    (excludePunctuation, so they are safe in URLs, SQL and shells). `secure` = 6-50 chars, upper+lower+digit."""
    await client.put("/passwordpreferences", {"validationPolicyId": 2})


async def ensure_read_only_role(client: FineractClient) -> tuple[int, int]:
    """Create the READ_*-only role (idempotent). Returns (role_id, number_of_permissions)."""
    roles = rows(await client.get("/roles"))
    role = next((r for r in roles if r["name"] == READ_ONLY_ROLE), None)
    if role:
        role_id = int(role["id"])
    else:
        role_id = int(
            (await client.post("/roles", {"name": READ_ONLY_ROLE, "description": "Read-only API access for the reliability product"}))[
                "resourceId"
            ]
        )
    perms = rows(await client.get("/permissions"))
    all_codes = sorted({str(p["code"]) for p in perms})
    read_codes = [c for c in all_codes if c.startswith("READ_") and c not in EXCLUDED_READ_CODES]
    granted = set(read_codes)
    # PUT is additive: send an explicit False for everything else so a re-seed removes hand-added grants.
    await client.put(f"/roles/{role_id}/permissions", {"permissions": {c: c in granted for c in all_codes}})
    return role_id, len(read_codes)


async def ensure_user(
    client: FineractClient, username: str, password: str, role_id: int, office_id: int, *, first: str, last: str
) -> int:
    users = rows(await client.get("/users"))
    existing = next((u for u in users if u["username"] == username), None)
    if existing:
        uid = int(existing["id"])
        await client.put(f"/users/{uid}", {"password": password, "repeatPassword": password, "roles": [role_id]})
        return uid
    r = await client.post(
        "/users",
        {
            "username": username,
            "firstname": first,
            "lastname": last,
            "email": f"{username.replace('_', '-')}@example.com",
            "officeId": office_id,
            "sendPasswordToEmail": False,
            "passwordNeverExpires": True,
            "password": password,
            "repeatPassword": password,
            "roles": [role_id],
        },
    )
    return int(r["resourceId"])


async def activate_loan_cob(client: FineractClient) -> dict[str, Any]:
    jobs = rows(await client.get("/jobs"))
    job = next(j for j in jobs if j["displayName"] == "Loan COB")
    await client.put(f"/jobs/{job['jobId']}", {"cronExpression": LOAN_COB_CRON, "active": True})
    return {"jobId": job["jobId"]}


async def _first_working_client(base_url: str, candidates: list[tuple[str, str]]) -> FineractClient:
    for user, pwd in candidates:
        c = FineractClient(base_url, user, pwd)
        try:
            await c.get("/offices")
            _log("seed.auth", username=user, status=200)
            return c
        except FineractError as exc:
            _log("seed.auth", username=user, status=exc.status)
            await c.aclose()
    raise SystemExit("seed: no working Fineract credentials")


async def main_async() -> None:
    base = os.environ["FINERACT_BASE_URL"]
    admin_user, admin_pw = os.environ["ADMIN_USERNAME"], os.environ["ADMIN_PASSWORD"]
    api_user, api_pw = os.environ["API_USERNAME"], os.environ["API_PASSWORD"]
    mifos_pw = os.environ["MIFOS_PASSWORD"]

    # First run: only the factory `mifos` / `password` works. Re-runs: harness_admin or the rotated mifos.
    client = await _first_working_client(
        base, [(admin_user, admin_pw), ("mifos", mifos_pw), ("mifos", "password")]
    )
    result = await seed(client)
    _log("seed.result", **result.__dict__)

    await relax_password_policy(client)
    super_role = next(r for r in rows(await client.get("/roles")) if r["name"] == "Super user")
    admin_id = await ensure_user(
        client, admin_user, admin_pw, int(super_role["id"]), result.office_id, first="Harness", last="Admin"
    )
    role_id, n_perms = await ensure_read_only_role(client)
    api_id = await ensure_user(client, api_user, api_pw, role_id, result.office_id, first="Reliability", last="API")
    _log("seed.users", harness_admin_id=admin_id, reliability_api_id=api_id, read_only_role_id=role_id, read_permissions=n_perms)
    await client.aclose()

    # Switch to harness_admin, then rotate the factory mifos password.
    admin = FineractClient(base, admin_user, admin_pw)
    mifos = next(u for u in rows(await admin.get("/users")) if u["username"] == "mifos")
    await admin.put(f"/users/{mifos['id']}", {"password": mifos_pw, "repeatPassword": mifos_pw})
    _log("seed.mifos_rotated", user_id=mifos["id"])

    job = await activate_loan_cob(admin)
    _log("seed.loan_cob", cron=LOAN_COB_CRON, **job)
    await admin.aclose()


def main() -> None:
    try:
        asyncio.run(main_async())
    except FineractError as exc:
        _log("seed.failed", status=exc.status, body=str(exc.body)[:500])
        sys.exit(1)


if __name__ == "__main__":
    main()
