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
):
    row = await (await conn.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM owner_ledger_events WHERE owner_id=%s",
        (owner_id,),
    )).fetchone()
    seq = row["next_seq"]
    clean_note = (note or "")[:200]
    if occurred_at is None:
        await conn.execute('''
            INSERT INTO owner_ledger_events(
                owner_id, seq, ledger_revision, request_id, kind,
                orders, positions, cash, note
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ''', (
            owner_id, seq, ledger_revision, request_id, kind,
            Jsonb(list(orders)), Jsonb(list(positions)), Jsonb(list(cash)), clean_note,
        ))
    else:
        await conn.execute('''
            INSERT INTO owner_ledger_events(
                owner_id, seq, ledger_revision, request_id, kind,
                occurred_at, orders, positions, cash, note
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ''', (
            owner_id, seq, ledger_revision, request_id, kind,
            occurred_at, Jsonb(list(orders)), Jsonb(list(positions)), Jsonb(list(cash)), clean_note,
        ))
    return seq


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


def checkpoint_to_registered_cash(checkpoint, overview):
    """Build a RegisteredCash-compatible payload purely from PG without touching disk archives."""
    from .legacy_registered_cash import CURRENCIES, SUMMARY_FIELDS, RegisteredCash

    raw_cash = checkpoint["cash_balances"]
    exact_balances = {
        currency: Decimal(str(raw_cash.get(currency, "0")))
        for currency in CURRENCIES
    }
    for currency, value in raw_cash.items():
        if currency not in exact_balances and value is not None:
            exact_balances[currency] = Decimal(str(value))
    values = {
        "balances": {c: float(v) for c, v in exact_balances.items()},
        "cardCash": {c: 0.0 for c in CURRENCIES},
        "summaries": {
            c: {
                "openingAsset": float(exact_balances[c]),
                "cashNetFlow": 0.0,
                "stockNetFlow": 0.0,
                "otherNetFlow": 0.0,
            }
            for c in CURRENCIES
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
