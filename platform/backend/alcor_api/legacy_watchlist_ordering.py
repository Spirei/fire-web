"""Legacy presentation order; never a financial event timestamp."""

from datetime import timedelta

from fastapi import HTTPException

from .portfolio_records import PortfolioRecords
from .watchlists import WatchGroups


async def legacy_assign(conn, db, who, ids, group_id):
    """Exact old id-index/sort gaps and true metadata update time; no financial writes.

    Caller owns the outer transaction, authorization revalidation, audit and receipt.
    Do not ship this helper alone as an exposed mutation endpoint.
    """
    groups = WatchGroups(db)
    await groups.lock(conn, who)
    records = PortfolioRecords(db)
    await records.lock(conn, who)
    if group_id:
        group = await (
            await conn.execute(
                "SELECT 1 FROM watch_groups WHERE owner_id=%s AND id=%s AND kind='custom' AND deleted_at IS NULL",
                (who, group_id),
            )
        ).fetchone()
        if not group:
            raise HTTPException(400, "分组不存在或不可分配")
    maximum = await (
        await conn.execute(
            "SELECT COALESCE(MAX(watch_group_sort),-1) AS value FROM portfolio_records WHERE owner_id=%s AND watch_group_id=%s AND deleted_at IS NULL",
            (who, group_id),
        )
    ).fetchone()
    count = 0
    for index, identifier in enumerate(ids):
        cursor = await conn.execute(
            "UPDATE portfolio_records SET watch_group_id=%s,watch_group_sort=%s,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE owner_id=%s AND id=%s AND deleted_at IS NULL",
            (group_id or None, maximum["value"] + index + 1 if group_id else 0, who, identifier),
        )
        count += cursor.rowcount
    return count


async def legacy_reorder(conn, db, owner, view, ids, *, now=None):
    """Preserve the old global-list observable order without forging stored event time.

    Compatibility sort timestamps live in an explicitly named projection table.
    They must never feed market/asset observations or financial proof generation.
    """
    await WatchGroups(db).lock(conn, owner)
    await PortfolioRecords(db).lock(conn, owner)
    if view == "__all" or view.startswith("market:"):
        market = view[7:] if view.startswith("market:") else ""
        rows = await (
            await conn.execute(
                "SELECT id FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL AND (%s='' OR market=%s)",
                (owner, market, market),
            )
        ).fetchall()
        if len(ids) != len(rows) or len(set(ids)) != len(ids) or set(ids) != {r["id"] for r in rows}:
            raise HTTPException(400, "列表成员已变化，请刷新后重试")
        if now is None:
            now = (
                await (
                    await conn.execute("SELECT date_trunc('milliseconds',clock_timestamp()) AS value")
                ).fetchone()
            )["value"]
        for index, identifier in enumerate(ids):
            # This actual metadata mutation increments record/collection versions.
            await conn.execute(
                "UPDATE portfolio_records SET updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE owner_id=%s AND id=%s",
                (owner, identifier),
            )
            await conn.execute(
                "INSERT INTO portfolio_legacy_ordering(owner_id,record_id,display_timestamp) VALUES(%s,%s,%s) ON CONFLICT(owner_id,record_id) DO UPDATE SET display_timestamp=excluded.display_timestamp",
                (owner, identifier, now - timedelta(milliseconds=index)),
            )
        return len(ids)
    group = await (
        await conn.execute(
            "SELECT 1 FROM watch_groups WHERE owner_id=%s AND id=%s AND kind='custom' AND deleted_at IS NULL",
            (owner, view),
        )
    ).fetchone()
    if not group:
        raise HTTPException(400, "分组不存在或不可排序")
    rows = await (
        await conn.execute(
            "SELECT id FROM portfolio_records WHERE owner_id=%s AND watch_group_id=%s AND deleted_at IS NULL",
            (owner, view),
        )
    ).fetchall()
    if len(ids) != len(rows) or len(set(ids)) != len(ids) or set(ids) != {r["id"] for r in rows}:
        raise HTTPException(400, "分组成员已变化，请刷新后重试")
    for index, identifier in enumerate(ids):
        await conn.execute(
            "UPDATE portfolio_records SET watch_group_sort=%s WHERE owner_id=%s AND id=%s",
            (index, owner, identifier),
        )
    return len(ids)
