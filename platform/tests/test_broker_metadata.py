"""Prepared synthetic integration vectors for the deferred focused validation batch."""

import asyncio
from uuid import uuid4

from test_broker_accounts import create
from test_cash_ledger import command as cash_command
from test_cash_ledger import submit as cash_submit
from test_legacy_devices import bearer, grant

ROOT = "/api/account/broker-metadata"


async def command(client, *, kind="create", identifier="", data=None):
    state = await client.get(ROOT)
    assert state.status_code == 200, state.text
    state = state.json()
    return {
        "kind": kind,
        "accountId": identifier,
        "expectedCollectionRevision": state["collectionRevision"],
        "expectedRecordCollectionRevision": state["recordCollectionRevision"],
        "data": data
        or {
            "request_id": str(uuid4()),
            "name": "Synthetic preview account",
            "provider_id": None,
            "account_kind": "real",
            "currency": "USD",
            "currencies": ["USD", "HKD"],
        },
    }


async def preview(client, value):
    result = await client.post(ROOT + "/preview", json=value)
    assert result.status_code == 200, result.text
    return {"previewId": result.json()["previewId"], "command": value}


async def test_metadata_original_uuid_atomic_duplicate_commit_and_unknown_close(client, admin, db):
    value = await command(client)
    body = await preview(client, value)
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM broker_accounts WHERE owner_id=%s", (admin,))
            ).fetchone()
        )["n"] == 0
        assert not await (
            await conn.execute("SELECT 1 FROM broker_account_operations WHERE owner_id=%s", (admin,))
        ).fetchone()
    results = await asyncio.gather(
        client.post(ROOT + "/operations", json=body), client.post(ROOT + "/operations", json=body)
    )
    assert all(result.status_code == 200 for result in results)
    assert results[0].json() == results[1].json() and results[0].json()["state"] == "completed"
    identifier = value["data"]["request_id"]
    assert (await client.get(ROOT + "/operations/" + identifier)).json() == results[0].json()
    assert (await client.post(ROOT + "/operations/" + identifier + "/close", json={})).json() == results[
        0
    ].json()
    later = await command(client)
    later["data"]["name"] = "Synthetic late request"
    late_body = await preview(client, later)
    identifier = later["data"]["request_id"]
    closed = await client.post(ROOT + "/operations/" + identifier + "/close", json={})
    assert (
        closed.status_code == 200
        and closed.json()["state"] == "closed"
        and closed.json()["executed"] is False
    )
    assert (await client.post(ROOT + "/operations", json=late_body)).json() == closed.json()
    assert len((await client.get(ROOT)).json()["accounts"]) == 1


async def test_metadata_stale_collection_and_zero_cash_reference_do_not_mutate_account(client, admin, db):
    value = await command(client)
    body = await preview(client, value)
    existing = await create(client, name="Synthetic concurrent directory account")
    assert (await client.post(ROOT + "/operations", json=body)).status_code == 409
    await cash_submit(client, cash_command(existing["id"], amount="0"))
    deleting = await command(
        client,
        kind="delete",
        identifier=existing["id"],
        data={"request_id": str(uuid4()), "revision": existing["revision"]},
    )
    assert (await client.post(ROOT + "/preview", json=deleting)).status_code == 409
    async with db.connection() as conn:
        assert not await (
            await conn.execute(
                "SELECT 1 FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                (admin, value["data"]["request_id"]),
            )
        ).fetchone()
        assert (
            await (
                await conn.execute(
                    "SELECT amount FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s",
                    (admin, existing["id"]),
                )
            ).fetchone()
        )["amount"] == 0


async def test_metadata_native_read_grant_cannot_preview_and_kind_is_explicit(client, admin, db):
    value = await command(client)
    missing = {**value, "data": {k: v for k, v in value["data"].items() if k != "account_kind"}}
    assert (await client.post(ROOT + "/preview", json=missing)).status_code == 422
    read = await grant(db, admin, "portfolio.read")
    native = "/api/client/broker-metadata"
    assert (await client.get(native, headers=bearer(read))).status_code == 200
    assert (await client.post(native + "/preview", json=value, headers=bearer(read))).status_code == 403
    write = await grant(db, admin, "portfolio.read portfolio.write")
    prepared = await client.post(native + "/preview", json=value, headers=bearer(write))
    assert prepared.status_code == 200, prepared.text
    assert (await client.post(ROOT + "/preview", json=value, headers=bearer(write))).status_code == 403
    # A different grant must not inherit a prior grant's pending preview.
    other = await grant(db, admin, "portfolio.read portfolio.write")
    response = await client.post(
        native + "/operations",
        json={"previewId": prepared.json()["previewId"], "command": value},
        headers=bearer(other),
    )
    assert response.status_code == 409
