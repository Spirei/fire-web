"""Synthetic fixture construction only; never an exporter/importer for real ledgers."""

from uuid import uuid4

from alcor_api.fee_source_inventory import FeeSourceInventory, fingerprint
from alcor_api.security import COOKIE, Identity, digest


async def identity(client, db):
    token = client.cookies[COOKIE]
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=%s",
                (digest(token),),
            )
        ).fetchone()
    return Identity(**row, token_hash=digest(token), csrf=client.headers["x-csrf-token"])


async def synthetic_snapshot(client, db, trade_id, *, extra=None, complete=True):
    who = await identity(client, db)
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT * FROM trade_ledger WHERE owner_id=%s AND id=%s", (who.id, trade_id))
        ).fetchone()
        record = await (
            await conn.execute(
                "SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s", (who.id, row["record_id"])
            )
        ).fetchone()
    entry = {
        "id": "legacy-" + str(row["id"]),
        "recordId": "legacy-" + record["id"],
        "status": "filled",
        "revision": 1,
        "recordRevision": record["revision"],
        "originalBrokerAccountId": "legacy-" + row["account_id"],
        "brokerAccountId": row["account_id"],
        "tradeId": str(row["id"]),
        "feeAuthority": row["source"],
        "cashAttribution": {
            "scope": "broker",
            "brokerAccountId": "legacy-" + row["account_id"],
            "currency": row["settlement_currency"],
            "postingId": "legacy-" + str(row["cash_entry_id"]),
            "alreadyReflected": True,
        },
        "input": {
            "side": row["side"],
            "quantity": str(row["quantity"]),
            "price": str(row["price"]),
            "amount": str(row["amount"]),
            "fees": str(row["fees"]),
            "currency": row["currency"],
            "settlementCurrency": row["settlement_currency"],
            "settlementAmount": None if row["settlement_amount"] is None else str(row["settlement_amount"]),
            "occurredAt": row["occurred_at"].isoformat(),
            "market": record["market"],
            "code": record["code"],
            "accountKind": row["account_kind"],
        },
    }
    return {
        "version": 1,
        "sourceInstance": "isolated-legacy-fixture",
        "sourceOwner": "legacy-fixture-" + who.id,
        "complete": complete,
        "orders": [entry, *(extra or [])],
    }


async def import_synthetic(client, db, source, *, request_id=None, revision=0):
    who = await identity(client, db)
    async with db.connection() as conn:
        name = (await (await conn.execute("SELECT current_database() AS name")).fetchone())["name"]
    return await FeeSourceInventory(db).import_trial(
        who,
        source,
        request_id=request_id or str(uuid4()),
        expected_database=name,
        expected_source_owner=source["sourceOwner"],
        expected_source_digest=fingerprint(source),
        expected_revision=revision,
    )
