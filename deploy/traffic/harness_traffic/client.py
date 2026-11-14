"""Thin async Fineract v1 API client."""

from __future__ import annotations

import datetime
from typing import Any

import httpx

API_PREFIX = "/fineract-provider/api/v1"


class FineractError(Exception):
    def __init__(self, status: int, body: dict[str, Any]) -> None:
        super().__init__(f"Fineract HTTP {status}: {str(body)[:300]}")
        self.status = status
        self.body = body


class FineractClient:
    def __init__(
        self,
        base_url: str,
        username: str,
        password: str,
        tenant: str = "default",
        timeout: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._http = httpx.AsyncClient(
            base_url=self.base_url + API_PREFIX,
            auth=(username, password),
            headers={"Fineract-Platform-TenantId": tenant},
            timeout=timeout,
        )

    async def _request(self, method: str, path: str, **kw: Any) -> dict[str, Any]:
        try:
            resp = await self._http.request(method, path, **kw)
        except httpx.HTTPError as exc:  # connection refused, timeout, ...
            raise FineractError(0, {"error": f"{type(exc).__name__}: {exc}"}) from exc
        try:
            body = resp.json()
        except ValueError:
            body = {"raw": resp.text[:500]}
        if resp.status_code >= 400:
            raise FineractError(resp.status_code, body if isinstance(body, dict) else {"body": body})
        return body if isinstance(body, dict) else {"body": body}

    async def post(self, path: str, json: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._request("POST", path, json=json or {})

    async def put(self, path: str, json: dict[str, Any]) -> dict[str, Any]:
        return await self._request("PUT", path, json=json)

    async def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._request("GET", path, params=params)

    async def aclose(self) -> None:
        await self._http.aclose()


def date_fields() -> dict[str, str]:
    """Fineract's dateFormat/locale pair; dates are formatted `dd MMMM yyyy`."""
    return {"dateFormat": "dd MMMM yyyy", "locale": "en"}


def fmt_date(on: datetime.date | None = None) -> str:
    return (on or datetime.date.today()).strftime("%d %B %Y")


def rows(resp: dict[str, Any]) -> list[dict[str, Any]]:
    """Fineract list endpoints return either a bare JSON array (wrapped as {"body": [...]}) or a page."""
    if "pageItems" in resp:
        return list(resp["pageItems"])
    body = resp.get("body")
    return list(body) if isinstance(body, list) else []
