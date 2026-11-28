"""Single-PG opening checkpoints and append-only structured ledger events."""

from decimal import Decimal
from uuid import UUID

from psycopg.types.json import Jsonb

from .broker_metadata import fingerprint


async def latest_checkpoint(conn, owner_id: str):
    return await (await conn.execute('''
        SELECT owner_id, checkpoint_version, request_id, account_kind,
               source_authority, source_sha256, cash_balances, position_costs,
               note, created_at
        FROM owner_ledger_checkpoints
        WHERE owner_id=%s
        ORDER BY checkpoint_version DESC
        LIMIT 1
    ''', (owner_id,))).fetchone()


async def checkpoint_by_request(conn, owner_id: str, request_id: UUID):
    return await (await conn.execute('''
        SELECT owner_id, checkpoint_version, request_id, account_kind,
               source_authority, source_sha256, cash_balances, position_costs,
               note, created_at
        FROM owner_ledger_checkpoints
        WHERE owner_id=%s AND request_id=%s
    ''', (owner_id, request_id))).fetchone()


async def append_ledger_event(
    conn,
    owner_id: str,
    *,
    request_id: UUID,
    kind: str,
    ledger_revision: int | None = None,
    orders=(),
    positions=(),
    cash=(),
    note: str = "",
    occurred_at=None,
    return_sequence=True,
):
    # Callers hold the existing owner writer lock when assigning the next sequence.
    cursor = await conn.execute("""
        INSERT INTO owner_ledger_events(
            owner_id, seq, ledger_revision, request_id, kind,
            occurred_at, orders, positions, cash, note
        )
        SELECT %s, COALESCE(MAX(seq), 0) + 1, %s, %s, %s,
               COALESCE(%s::timestamptz, clock_timestamp()), %s, %s, %s, %s
        FROM owner_ledger_events WHERE owner_id=%s
        RETURNING seq
    """, (
        owner_id, ledger_revision, request_id, kind, occurred_at, Jsonb(list(orders)),
        Jsonb(list(positions)), Jsonb(list(cash)), (note or "")[:200], owner_id,
    ))
    if return_sequence:
        return (await cursor.fetchone())["seq"]


async def recent_ledger_events(conn, owner_id: str, *, limit: int = 30):
    rows = await (await conn.execute('''
        SELECT seq, ledger_revision, request_id, kind, occurred_at,
               orders, positions, cash, note, created_at
        FROM owner_ledger_events
        WHERE owner_id=%s
        ORDER BY seq DESC
        LIMIT %s
    ''', (owner_id, limit))).fetchall()
    return [
        {
            "seq": row["seq"],
            "revision": row["ledger_revision"],
            "requestId": str(row["request_id"]),
            "kind": row["kind"],
            "occurredAt": row["occurred_at"].isoformat(),
            "createdAt": row["created_at"].isoformat(),
            "note": row["note"],
            "orders": row["orders"],
            "positions": row["positions"],
            "cash": row["cash"],
        }
        for row in rows
    ]


async def create_opening_checkpoint(
    conn,
    owner_id: str,
    *,
    request_id: UUID,
    source_authority: str,
    source_sha256: str | None,
    cash_balances: dict[str, str],
    position_costs: list[dict],
    note: str = "",
):
    row = await (await conn.execute(
        "SELECT COALESCE(MAX(checkpoint_version), 0) + 1 AS next_ver FROM owner_ledger_checkpoints WHERE owner_id=%s",
        (owner_id,),
    )).fetchone()
    version = row["next_ver"]
    clean_note = (note or "")[:200]
    created = await (await conn.execute('''
        INSERT INTO owner_ledger_checkpoints(
            owner_id, checkpoint_version, request_id, account_kind,
            source_authority, source_sha256, cash_balances, position_costs, note
        ) VALUES (%s, %s, %s, 'real', %s, %s, %s, %s, %s)
        RETURNING checkpoint_version, created_at
    ''', (
        owner_id, version, request_id, source_authority, source_sha256,
        Jsonb(cash_balances), Jsonb(position_costs), clean_note,
    ))).fetchone()
    cash_event = [{"currency": c, "balance": v} for c, v in sorted(cash_balances.items())]
    await append_ledger_event(
        conn, owner_id,
        request_id=request_id, kind="opening_checkpoint",
        ledger_revision=None,
        positions=position_costs, cash=cash_event, note=clean_note,
    )
    return {
        "ownerId": owner_id,
        "requestId": str(request_id),
        "checkpointVersion": created["checkpoint_version"],
        "sourceAuthority": source_authority,
        "sourceSha256": source_sha256,
        "cashCurrencies": len(cash_balances),
        "positionCount": len(position_costs),
        "note": clean_note,
        "createdAt": created["created_at"].isoformat(),
    }


async def checkpoint_to_registered_cash(conn, owner_id: str, checkpoint, overview):
    """Build a RegisteredCash-compatible payload purely from PG without touching disk archives."""
    from .legacy_registered_cash import CURRENCIES, RegisteredCash

    raw_cash = checkpoint["cash_balances"]
    exact_balances = {
        currency: Decimal(str(raw_cash.get(currency, "0")))
        for currency in CURRENCIES
    }
    for currency, value in raw_cash.items():
        if currency not in exact_balances and value is not None:
            exact_balances[currency] = Decimal(str(value))
    # Incorporate any real-account PG cash postings written after the checkpoint
    # (pre-adoption deposits/withdrawals; post-adoption writes are fenced off).
    post_rows = await (await conn.execute('''
        SELECT currency, kind, COALESCE(SUM(amount), 0) AS amount
        FROM cash_ledger_entries
        WHERE owner_id=%s AND account_kind=%s AND affects_owner AND created_at > %s
        GROUP BY currency, kind
        ORDER BY currency, kind
    ''', (owner_id, checkpoint["account_kind"], checkpoint["created_at"]))).fetchall()
    canonical = {
        r["currency"]: r
        for b in overview["books"]
        if b["accountKind"] == checkpoint["account_kind"]
        for r in b["currencies"]
    }
    opened_after = {row["currency"] for row in post_rows if row["kind"] == "opening"}
    summaries = {
        c: {
            "openingAsset": Decimal(exact_balances[c]),
            "cashNetFlow": Decimal(0),
            "stockNetFlow": Decimal(0),
            "otherNetFlow": Decimal(0),
        }
        for c in CURRENCIES
    }
    for currency in opened_after:
        observed = canonical.get(currency)
        if observed and observed["complete"] and observed["ownerBalance"] is not None:
            exact_balances[currency] = Decimal(str(observed["ownerBalance"]))
            if currency in summaries:
                summaries[currency] = {
                    "openingAsset": Decimal(0), "cashNetFlow": Decimal(0),
                    "stockNetFlow": Decimal(0), "otherNetFlow": Decimal(0),
                }
    for row in post_rows:
        currency = row["currency"]
        delta = Decimal(str(row["amount"]))
        if currency not in opened_after:
            exact_balances[currency] = exact_balances.get(currency, Decimal(0)) + delta
        if currency in summaries:
            kind = row["kind"]
            field = (
                "openingAsset" if kind == "opening"
                else "cashNetFlow" if kind in ("external_deposit", "external_withdrawal")
                else "stockNetFlow" if kind.startswith(("trade_", "fee_"))
                else "otherNetFlow"
            )
            summaries[currency][field] += delta
    values = {
        "balances": {c: float(v) for c, v in exact_balances.items()},
        "cardCash": {c: 0.0 for c in CURRENCIES},
        "summaries": {
            c: {k: float(v) for k, v in s.items()}
            for c, s in summaries.items()
        },
    }
    dto = {
        **values,
        "snapshotRevision": fingerprint([
            "owner_ledger_checkpoint",
            checkpoint["checkpoint_version"],
            checkpoint["source_sha256"],
            overview["snapshotRevision"],
            values,
        ]),
        "sourceComplete": True,
        "cardCashCoverageKnown": True,
        "historicalCoverageKnown": False,
        "coverageScope": "single_pg_opening_checkpoint",
        "sourceAuthority": checkpoint["source_authority"],
        "accountKind": checkpoint["account_kind"],
        "unboundLegacyGlobalCashIncluded": True,
        "accountKindsCombined": False,
        "sourceOrdersReplayed": False,
        "actualBrokerBalanceClaimed": False,
    }
    return RegisteredCash(dto, exact_balances)
