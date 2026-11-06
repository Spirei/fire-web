"""Point-in-time official observations; registered ledgers and history remain separate."""

from decimal import Decimal, InvalidOperation

from fastapi import HTTPException


def decimal_text(value):
    if value is None:
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(503, "官方快照数值暂时无法核对") from None
    if not number.is_finite():
        raise HTTPException(503, "官方快照数值暂时无法核对")
    # Keep exact scientific notation when fixed-point expansion could be enormous.
    return str(number) if number.as_tuple().exponent < -64 or number.adjusted() > 64 else format(number, "f")


def source_view(row):
    if row is None:
        return {
            "state": "unavailable",
            "authority": "official_statement_snapshot",
            "asOf": None,
            "reportDate": None,
            "sourceSha256": None,
            "asOfPrecision": "report_date",
            "financialHistoryReplayed": False,
        }
    return {
        "state": "reported",
        "authority": "official_statement_snapshot",
        "importId": str(row["id"]),
        "originalId": str(row["original_id"]),
        "sourceSha256": row["source_sha256"],
        "asOf": row["to_date"].isoformat(),
        "reportDate": row["to_date"].isoformat(),
        "fromDate": row["from_date"].isoformat(),
        "asOfPrecision": "report_date",
        "importedAt": row["created_at"].isoformat(),
        "financialHistoryReplayed": False,
    }


async def latest_official(conn, owner, account_id):
    account = await (
        await conn.execute(
            "SELECT id,account_kind,holding_source,deleted_at FROM broker_accounts WHERE owner_id=%s AND id=%s",
            (owner, account_id),
        )
    ).fetchone()
    if not account:
        raise HTTPException(503, "账户归属暂时无法核对")
    if account["holding_source"] != "official":
        return None
    if account["deleted_at"] is not None:
        raise HTTPException(503, "官方账户状态暂时无法核对")
    report = await (
        await conn.execute(
            "SELECT * FROM broker_statement_imports WHERE owner_id=%s AND account_id=%s ORDER BY to_date DESC,created_at DESC,id DESC LIMIT 1",
            (owner, account_id),
        )
    ).fetchone()
    if report and report["account_kind"] != account["account_kind"]:
        raise HTTPException(503, "官方快照账本类型不一致")
    return {"account": account, "report": report, "source": source_view(report)}


async def official_record(conn, owner, row):
    if not row["broker_account_id"]:
        return None
    current = await latest_official(conn, owner, row["broker_account_id"])
    if current is None:
        return None
    report = current["report"]
    position = None
    if report:
        position = await (
            await conn.execute(
                "SELECT quantity,cost,price,source_absent FROM broker_statement_positions WHERE owner_id=%s AND import_id=%s AND account_id=%s AND record_id=%s",
                (owner, report["id"], row["broker_account_id"], row["id"]),
            )
        ).fetchone()
    # Never fall back to an older import or assume zero from an absent mapping.
    return {
        "qty": decimal_text(position["quantity"]) if position else None,
        "cost": decimal_text(position["cost"]) if position else None,
        "price": decimal_text(position["price"]) if position else None,
        "sourceAbsent": bool(position["source_absent"]) if position else None,
        "officialObservation": {**current["source"], "recordMapped": position is not None},
        "costAuthority": "official_reported_cost_basis",
        "positionAuthority": "official_reported_position",
        "priceAuthority": "official_reported_mark_price",
    }


async def official_cash(conn, owner, account_id):
    current = await latest_official(conn, owner, account_id)
    if current is None:
        return None
    cash = {}
    report = current["report"]
    if report:
        values = report["statement"].get("cash")
        if not isinstance(values, list):
            raise HTTPException(503, "官方现金快照暂时无法核对")
        for row in values:
            if (
                not isinstance(row, dict)
                or not isinstance(row.get("currency"), str)
                or row["currency"] in cash
            ):
                raise HTTPException(503, "官方现金币种暂时无法核对")
            currency = row["currency"]
            if (
                len(currency) != 3
                or not currency.isascii()
                or not currency.isalpha()
                or not currency.isupper()
            ):
                raise HTTPException(503, "官方现金币种暂时无法核对")
            cash[currency] = decimal_text(row.get("endingCash"))
    return {"cash": cash, "officialObservation": current["source"]}
