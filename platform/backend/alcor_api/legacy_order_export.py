"""Workbook export of registered facts; unknown cells remain unknown."""

import re
from collections import Counter
from datetime import UTC, datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException, Request
from fastapi.responses import Response

from .legacy_flat_orders import order_identity, select_orders, snapshot
from .legacy_order_workbooks import DETAIL, HEADERS, LONGBRIDGE_HEADERS, LONGBRIDGE_LOG, build_xlsx

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


def workbook(orders, detail, *, include_fees=False, longbridge_layout=False):
    rows = [HEADERS + ["费用", "券商", "券商账户标识", "原券商订单号"] if include_fees else HEADERS]
    details = [DETAIL]
    longbridge_orders = [LONGBRIDGE_HEADERS + HEADERS[21:] + ["费用", "成交时间", "来源", "原券商订单号"]]
    longbridge_log = [LONGBRIDGE_LOG]
    order_numbers = Counter(str(order["orderNo"]) for order in orders if order.get("orderNo")) if longbridge_layout else {}
    for order in orders:
        market = order["market"]
        filled = order["status"] == "filled"
        fee = order.get("fees") if filled and order.get("feeSource") not in (
            "legacy_import_placeholder", "unverified_legacy", "estimated_not_actual_paid",
        ) else None
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
        if filled and order["side"] in ("buy", "sell"):
            if price is None:
                price = order.get("price")
            if quantity is None:
                quantity = order.get("qty")
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
            row.extend([fee, order.get("broker"), order.get("brokerAccountId"), order.get("originalOrderNo")])
        rows.append(row)
        if longbridge_layout:
            # Fire's recorded fill time is authoritative only as a Fire receipt.
            # Leave order placement unknown when the origin did not supply it.
            broker_row = row[:24].copy()
            broker_row[1] = market
            broker_row[4] = {"buy": "买", "sell": "卖"}.get(order["side"], side)
            broker_row[10] = None
            broker_row[12] = quantity if quantity is not None else 0
            original = order.get("orderNo")
            broker_row[19] = str(original if original and order_numbers.get(str(original)) == 1 else order["id"])
            longbridge_orders.append(broker_row[:11] + [None] + broker_row[11:] + [
                fee, order["tradedAt"] if filled else None, "Fire登记历史", order.get("originalOrderNo"),
            ])
            if filled and order["side"] in ("buy", "sell") and price is not None and quantity is not None:
                longbridge_log.append([broker_row[19], market, order["code"], order["name"], broker_row[4],
                                       order["tradedAt"], status, price, quantity, "Fire登记成交"])
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
                fee if include_fees else order.get("fees") if filled else None,
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
    if longbridge_layout:
        return build_xlsx([("Orders", longbridge_orders), ("Trade Log", longbridge_log)]
                          + ([("订单明细", details)] if detail else []))
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
            workbook(orders, query.get("detail") == "1", include_fees=canonical,
                     longbridge_layout=canonical and query.get("format") == "longbridge"),
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
