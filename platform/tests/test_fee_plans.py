from uuid import uuid4

import pytest
from psycopg.errors import CheckViolation


async def account(client):
    response = await client.post(
        "/api/broker-accounts",
        json={
            "request_id": str(uuid4()),
            "name": "Fee test account",
            "provider_id": "longbridge",
            "account_kind": "real",
            "currency": "USD",
            "currencies": ["USD"],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["data"]["id"]


def payload(account_id):
    return {
        "requestId": str(uuid4()),
        "planId": str(uuid4()),
        "revision": 0,
        "accountId": account_id,
        "providerId": "longbridge",
        "effectiveFrom": "2025-05-14",
        "effectiveThrough": "2026-10-20",
        "components": {
            "commission": {"basis": "free"},
            "platform": {"basis": "share", "rate": "0.005", "minimum": "1"},
        },
        "confirmed": True,
    }


@pytest.mark.asyncio
async def test_plan_preview_receipt_cas_no_cash_rewrite(client, admin, db):
    aid = await account(client)
    data = payload(aid)
    preview = await client.post("/api/fees/plans/preview", json=data)
    assert preview.status_code == 200, preview.text
    assert preview.json()["cashEffect"] is None
    result = await client.post(
        "/api/fees/plans/operations", json={"data": data, "preview": preview.json()["preview"]}
    )
    assert result.status_code == 200, result.text
    duplicate = await client.post(
        "/api/fees/plans/operations", json={"data": data, "preview": preview.json()["preview"]}
    )
    assert duplicate.json() == result.json()
    assert (await client.get("/api/fees/plans/operations/" + data["requestId"])).json() == result.json()
    stale = {**data, "requestId": str(uuid4())}
    assert (await client.post("/api/fees/plans/preview", json=stale)).status_code == 409
    listing = await client.get("/api/fees/plans", params={"accountId": aid})
    assert listing.json()["items"][0]["revision"] == 1
    async with db.connection() as conn:
        for table in ("cash_ledger_entries", "trade_ledger"):
            assert (await (await conn.execute("SELECT count(*) AS n FROM " + table)).fetchone())["n"] == 0
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute("UPDATE fee_plan_revisions SET components='{}'")


@pytest.mark.asyncio
async def test_session_bound_proof(client, admin, db):
    data = payload(await account(client))
    preview = (await client.post("/api/fees/plans/preview", json=data)).json()
    await client.post("/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"})
    from alcor_api.security import COOKIE, csrf_token

    client.headers["x-csrf-token"] = csrf_token(client.cookies.get(COOKIE))
    assert (
        await client.post("/api/fees/plans/operations", json={"data": data, "preview": preview["preview"]})
    ).status_code == 409
