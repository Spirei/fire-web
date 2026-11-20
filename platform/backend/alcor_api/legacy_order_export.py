"""Workbook export of registered facts; unknown cells remain unknown."""

import re
from datetime import UTC, datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException, Request
from fastapi.responses import Response

from .legacy_flat_orders import order_identity, select_orders, snapshot
from .legacy_order_workbooks import DETAIL, HEADERS, build_xlsx

MARKET_LABEL = {
    "US": "美股",
    "HK": "港股",
    "CN": "A股",
    "JP": "日股",
    "KR": "韩股",
    "SG": "新加坡",
    "UK": "英国",
}
CURRENCIES = {"US": "USD", "HK": "HKD", "CN": "CNY", "JP": "JPY", "KR": "KRW", "SG": "SGD", "UK": "GBP"}
ZONES = {
    "US": ("America/New_York", " ET"),
    "HK": ("Asia/Hong_Kong", " 北京时间"),
    "CN": ("Asia/Shanghai", " 北京时间"),
    "JP": ("Asia/Tokyo", " 东京时间"),
    "KR": ("Asia/Seoul", " 首尔时间"),
}


def time_text(value, market):
    if not value:
        return None
    when = datetime.fromisoformat(value)
    if market in ZONES:
        zone, suffix = ZONES[market]
        return when.astimezone(ZoneInfo(zone)).strftime("%Y-%m-%d %H:%M:%S") + suffix
    return when.astimezone(UTC).isoformat()


def workbook(orders, detail, *, include_fees=False):
    rows = [HEADERS + ["费用"] if include_fees else HEADERS]
    details = [DETAIL]
    for order in orders:
        market = order["market"]
        filled = order["status"] == "filled"
        status = {
            "filled": "已成交",
            "cancelled": "已撤销",
            "pending": "待成交",
            "expired": "已过期",
            "imported_suspended": "原意图暂停",
        }.get(order["status"], order["status"])
        side = {"buy": "买入", "sell": "卖出", "dividend": "股息"}.get(order["side"], order["side"])
        amount = order.get("amount") if filled else None
        price = order.get("executedPrice") if filled else None
        quantity = order.get("filledQty") if filled else None
        typ = order.get("orderType")
        row = [
            status,
            MARKET_LABEL.get(market, market),
            order["code"],
            order["name"],
            side,
            typ,
            order.get("qty"),
            order.get("orderPrice") if not filled else order.get("price"),
            order.get("triggerPrice"),
            CURRENCIES.get(market),
            time_text(order["tradedAt"], market),
            price,
            quantity,
            amount,
            order.get("qty") if order["status"] == "pending" else None,
            order.get("qty")
            if order["status"] == "cancelled" and order["executionModel"] == "internal_pending"
            else None,
            order.get("tif"),
            order.get("session"),
            order.get("triggerStatus"),
            order.get("orderNo"),
            None,
            MARKET_LABEL.get(order.get("accountMarket"), order.get("accountMarket")),
            order.get("settlementCurrency"),
            order.get("settlementAmount"),
        ]
        if include_fees:
            row.append(order.get("fees") if filled else None)
        rows.append(row)
        details.append(
            [
                order.get("orderNo"),
                status,
                MARKET_LABEL.get(market, market),
                order["code"],
                order["name"],
                side,
                typ,
                order.get("qty"),
                order.get("price"),
                CURRENCIES.get(market),
                time_text(order["tradedAt"], market),
                price,
                quantity,
                amount,
                order.get("fees") if filled else None,
                order.get("realizedPnl"),
                order.get("positionQtyAfter"),
                order.get("positionCostAfter"),
                order.get("tif"),
                order.get("session"),
                order.get("triggerStatus"),
                None,
                order.get("note"),
                MARKET_LABEL.get(order.get("accountMarket"), order.get("accountMarket")),
                order.get("settlementCurrency"),
                order.get("settlementAmount"),
            ]
        )
    return build_xlsx([("订单", rows)] + ([("订单明细", details)] if detail else []))


def export_selection(view, query, *, canonical, now=None):
    now = now or datetime.now(UTC)
    account_market = query.get("accountMarket", "ALL").upper() if canonical else "ALL"
    listing_market = query.get("market", "ALL").upper()
    scope = query.get("scope", "all")
    scope = scope if scope in ("today", "history") else "all"
    default_zone = ZoneInfo("Asia/Shanghai")
    exchange_calendar = canonical and "calendarZone" in query
    if exchange_calendar:
        try:
            default_zone = ZoneInfo(query["calendarZone"])
        except (ValueError, ZoneInfoNotFoundError):
            raise HTTPException(422, "无效的订单日历时区") from None
    start, end = query.get("start", "").strip(), query.get("end", "").strip()
    selected = []
    for order in view["orders"]:
        market = order["market"]
        owner_market = "CN" if market == "HK" and order.get("accountMarket") == "CN" else market
        if listing_market not in ("ALL", market) or account_market not in ("ALL", owner_market):
            continue
        if query.get("status", "all") not in ("all", order["status"]):
            continue
        if query.get("type") in ("stock", "etf"):
            if bool(re.search(r"ETF|做多|杠杆", order["name"], re.IGNORECASE)) != (query["type"] == "etf"):
                continue
        zone = ZoneInfo(ZONES[market][0]) if exchange_calendar and market in ZONES else default_zone
        day = datetime.fromisoformat(order["tradedAt"]).astimezone(zone).date().isoformat()
        if exchange_calendar:
            today = now.astimezone(zone).date().isoformat()
            if (scope == "today" and day != today) or (scope == "history" and day == today):
                continue
        if (start and day < start) or (end and day > end):
            continue
        selected.append(order)
    # Apply the limit after every displayed filter, so older matching rows remain reachable.
    args = {**query, "scope": "all" if exchange_calendar else scope}
    return select_orders({**view, "orders": selected}, args, maximum=10000)["orders"], scope


def mount_order_export(app, db):
    async def export(request: Request):
        who = await order_identity(request, db)
        query = dict(request.query_params)
        query.setdefault("limit", "5000")
        canonical = request.url.path == "/api/trading/history/export"
        async with db.connection() as conn, conn.transaction():
            view = await snapshot(conn, who, exact=True)
        orders, scope = export_selection(view, query, canonical=canonical)
        filename = (
            "订单导出-"
            + {"all": "全部", "today": "当日", "history": "历史"}[scope]
            + "-"
            + datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d")
            + ".xlsx"
        )
        return Response(
            workbook(orders, query.get("detail") == "1", include_fees=canonical),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Cache-Control": "no-store",
                "Content-Disposition": "attachment; filename*=UTF-8''" + quote(filename),
                "X-Alcor-Snapshot-Revision": view["snapshotRevision"],
                "X-Alcor-Export-Authority": "registered-platform-history",
            },
        )

    app.add_api_route(
        "/api/v1/orders/export", export, methods=["GET"], operation_id="legacy_orders_export_v1"
    )
    app.add_api_route(
        "/api/trading/history/export", export, methods=["GET"], operation_id="trading_history_export"
    )
