"""Workbook export of registered facts; unknown cells remain unknown."""

import re
from datetime import UTC, datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import Request
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


def workbook(orders, detail):
    rows = [HEADERS]
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


def mount_order_export(app, db):
    async def export(request: Request):
        who = await order_identity(request, db)
        query = dict(request.query_params)
        query.setdefault("limit", "5000")
        async with db.connection() as conn, conn.transaction():
            view = await snapshot(conn, who, exact=True)
            market = query.get("market", "ALL").upper()
            status = query.get("status", "all")
            filtered = {
                **view,
                "orders": [
                    o
                    for o in view["orders"]
                    if (market == "ALL" or o["market"] == market)
                    and (status == "all" or o["status"] == status)
                ],
            }
            selected = select_orders(filtered, query, maximum=10000)
        orders = selected["orders"]
        if query.get("type") in ("stock", "etf"):
            orders = [
                o
                for o in orders
                if bool(re.search(r"ETF|做多|杠杆", o["name"], re.IGNORECASE)) == (query["type"] == "etf")
            ]
        for field, comparison in (("start", lambda a, b: a >= b), ("end", lambda a, b: a <= b)):
            if query.get(field):
                orders = [
                    o
                    for o in orders
                    if comparison(
                        datetime.fromisoformat(o["tradedAt"])
                        .astimezone(ZoneInfo("Asia/Shanghai"))
                        .date()
                        .isoformat(),
                        query[field].strip(),
                    )
                ]
        filename = (
            "订单导出-"
            + {"all": "全部", "today": "当日", "history": "历史"}[selected["scope"]]
            + "-"
            + datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d")
            + ".xlsx"
        )
        return Response(
            workbook(orders, query.get("detail") == "1"),
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
