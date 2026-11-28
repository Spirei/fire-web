"""File explorer reads for individual account-owned ledger facts."""

import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from hashlib import sha256
from urllib.parse import quote

from fastapi import HTTPException, Request
from fastapi.responses import Response
from psycopg import sql

from .card_preferences_protocol import wire_response
from .native_ledger import ledger_head
from .native_ledger_projection import changed_position_ids, position_rows
from .native_trade_sync import order_projection
from .personal_ledger_archive import PRIVATE, investment_file_actor
from .portfolio_series import packed
from .security import assert_expected_account, lock_read_identity


@dataclass(frozen=True)
class RecordType:
    section: str
    table: str
    key: str
    at: str
    fields: str


TYPES = {
    "position": RecordType("positions", "portfolio_records", "id", "updated_at", "name code market qty cost source revision broker_account_id deleted_at"),
    "trade": RecordType("trades", "trade_ledger", "id", "occurred_at", "side quantity price amount fees currency source record_id account_id"),
    "appFill": RecordType("trades", "native_synced_fills", "trade_id", "occurred_at", "fill synced_at"),
    "appOrder": RecordType("trades", "native_synced_orders", "order_id", "occurred_at", "status item synced_at"),
    "nativeCash": RecordType("funds", "native_ledger_transactions", "request_id", "created_at", "event revision"),
    "nativeCorrection": RecordType("corrections", "native_ledger_transactions", "request_id", "created_at", "event revision"),
    "declaration": RecordType("trades", "personal_order_declarations", "id", "created_at", "record_id raw"),
    "cash": RecordType("funds", "cash_ledger_entries", "id", "occurred_at", "kind amount currency account_id request_id source_trade_id"),
    "amendment": RecordType("corrections", "trade_amendments", "id", "created_at", "action trade_id record_id previous_amendment_id request_id"),
    "feeCorrection": RecordType("corrections", "trade_fee_corrections", "id", "created_at", "trade_id new_fees old_fees request_id"),
    "fundReversal": RecordType("corrections", "fund_source_retirements", "source_id", "created_at", "source_id request_id reversal_entry_id"),
    "cashCorrection": RecordType("corrections", "cash_reconciliation_evidence", "request_id", "created_at", "registered_before target_balance delta currency account_id"),
    "transfer": RecordType("corrections", "broker_position_transfers", "id", "created_at", "source_record_id target_record_id request_id quantity"),
    "statement": RecordType("originals", "broker_statement_originals", "id", "created_at", "provider external_account source_sha256 account_id"),
    "orderFile": RecordType("originals", "legacy_order_import_sources", "id", "created_at", "filename sha256"),
    "financialImport": RecordType("originals", "financial_import_sources", "id", "created_at", "source_instance source_version sha256"),
    "historyImport": RecordType("originals", "database_migration_history_imports", "request_id", "created_at", "source_instance source_sha256 result"),
}

NATIVE_ORDER = "nativeOrder"
NATIVE_CASH_FILTER = sql.SQL("jsonb_array_length(COALESCE(event->'cash', '[]'::jsonb)) > 0")
NATIVE_CORRECTION_FILTER = sql.SQL(
    """jsonb_path_exists(event, '$.orders[*] ? (@.editHistory != null || @.deletedFrom == "filled")')"""
)


# List only actual identifiers found in storage. A manually registered row may
# have no external original, and the API never assigns one by matching names.
FORWARD = {
    "position": (("trade_tip_id", "trade"), ("amendment_tip_id", "amendment")),
    "trade": (("record_id", "position"), ("cash_entry_id", "cash"), ("previous_trade_id", "trade")),
    "declaration": (("record_id", "position"),),
    "cash": (("source_trade_id", "trade"), ("trade_amendment_id", "amendment")),
    "amendment": (("trade_id", "trade"), ("record_id", "position"), ("previous_amendment_id", "amendment")),
    "feeCorrection": (("trade_id", "trade"),),
    "fundReversal": (("reversal_entry_id", "cash"),),
    "cashCorrection": (("entry_id", "cash"),),
    "transfer": (("source_record_id", "position"), ("target_record_id", "position")),
}
REVERSE = {
    "position": (("trade", "record_id"), ("amendment", "record_id"), ("declaration", "record_id"),
                 ("transfer", "source_record_id"), ("transfer", "target_record_id")),
    "trade": (("amendment", "trade_id"), ("feeCorrection", "trade_id"), ("cash", "source_trade_id")),
    "amendment": (("cash", "trade_amendment_id"),),
}
LIMIT = 24
# The archive groups the requested brokerage securities without changing their market or record IDs.
POSITION_FOLDER = sql.SQL("CASE WHEN t.market = 'US' AND upper(t.code) IN ('IBKR','SCHW') THEN 'brokers' ELSE t.market END")
ORIGINALS = {
    "statement": ("source_bytes", "source_sha256", "statement.xml"),
    "orderFile": ("raw", "sha256", None),
    "financialImport": ("raw", "sha256", "financial-import.json"),
    "historyImport": ("originals", "source_sha256", "migration-history.json"),
}


def file_format(name, raw):
    if raw.startswith(b"%PDF-"):
        return "pdf"
    if raw.startswith(b"PK\x03\x04") and name.lower().endswith(".xlsx"):
        return "xlsx"
    if raw.lstrip(b"\xef\xbb\xbf \t\r\n").startswith((b"{", b"[")) and name.lower().endswith(".json"):
        return "json"
    if name.lower().endswith((".csv", ".tsv")):
        return "csv"
    if name.lower().endswith((".xml", ".txt")):
        return "text"
    return "download"


async def original_file(conn, owner, kind, identifier):
    if kind not in ORIGINALS:
        raise HTTPException(404, "此记录没有独立文件")
    source, digest_column, default_name = ORIGINALS[kind]
    spec = TYPES[kind]
    filename = sql.Literal(default_name) if default_name else sql.Identifier("filename")
    query = sql.SQL("SELECT {} AS content,{} AS checksum,{} AS filename FROM {} WHERE owner_id=%s AND {}::text=%s").format(
        sql.Identifier(source), sql.Identifier(digest_column), filename, sql.Identifier(spec.table), sql.Identifier(spec.key))
    row = await (await conn.execute(query, (owner, identifier))).fetchone()
    if not row:
        raise HTTPException(404, "找不到本人的原件")
    if kind == "historyImport":
        from .database_migration_capture import canonical

        raw = canonical(row["content"])
        if isinstance(raw, str):
            raw = raw.encode()
    else:
        raw = bytes(row["content"])
    if sha256(raw).hexdigest() != row["checksum"]:
        raise HTTPException(409, "原件完整性校验失败")
    return raw, row["filename"], row["checksum"]


def native_event_filter(kind):
    return {"nativeCash": NATIVE_CASH_FILTER, "nativeCorrection": NATIVE_CORRECTION_FILTER}.get(kind)


def summary_sql(kind, spec):
    pairs = [sql.SQL("{}, to_jsonb(t)->{}").format(sql.Literal(field), sql.Literal(field))
             for field in spec.fields.split()]
    query = sql.SQL("SELECT {} AS type, {}::text AS id, {} AS at, jsonb_build_object({})::text AS data "
                   "FROM {} t WHERE owner_id=%s").format(
        sql.Literal(kind), sql.Identifier(spec.key), sql.Identifier(spec.at), sql.SQL(", ").join(pairs),
        sql.Identifier(spec.table),
    )
    if kind == "appFill":
        query += sql.SQL(" AND NOT EXISTS (SELECT 1 FROM native_synced_orders o WHERE o.owner_id=t.owner_id AND o.order_id=t.trade_id)")
    if kind == "appOrder":
        query += sql.SQL(" AND t.status<>'deleted'")
    if condition := native_event_filter(kind):
        query += sql.SQL(" AND ") + condition
    return query


def decoded(row):
    return {**row, "data": json.loads(row["data"], parse_float=Decimal, parse_int=Decimal)}


async def native_positions(conn, owner, head):
    ids = sorted(changed_position_ids(head))
    if not ids:
        return []
    prior = await (await conn.execute(
        "SELECT id,revision FROM portfolio_records WHERE owner_id=%s AND id=ANY(%s)", (owner, ids),
    )).fetchall()
    return position_rows(prior, head)


def position_market(row):
    return "brokers" if row["market"] == "US" and row["code"].upper() in {"IBKR", "SCHW"} else row["market"]


def position_entry(row):
    fields = TYPES["position"].fields.split() + ["code", "account_market"]
    return {"type": "position", "id": row["id"], "at": row["updated_at"],
            "data": {field: row.get(field) for field in fields}}


def order_entries(head):
    if head:
        for item in head["snapshot"]["orders"]:
            if item["status"] != "deleted":
                yield {"type": NATIVE_ORDER, "id": item["tradeId"],
                       "at": datetime.fromisoformat(item.get("filledAt") or item["createdAt"]),
                       "data": {key: item[key] for key in ("recordId", "name", "code", "market", "side", "status")}}


def entry_key(row):
    return row["at"], row["type"], row["id"]


async def list_position_folders(conn, owner, head):
    positions = await native_positions(conn, owner, head)
    rows = await (await conn.execute(sql.SQL(
        "SELECT {} AS market, COUNT(*) AS count FROM portfolio_records t "
        "WHERE owner_id=%s AND NOT (id=ANY(%s)) GROUP BY 1"
    ).format(POSITION_FOLDER), (owner, [row["id"] for row in positions]))).fetchall()
    counts = {row["market"]: row["count"] for row in rows}
    for row in positions:
        market = position_market(row)
        counts[market] = counts.get(market, 0) + 1
    return {"items": [{"market": market, "count": counts[market]} for market in sorted(counts)], "next": None}


async def list_records(conn, owner, section, before, market=None, head=None):
    kinds = {kind: spec for kind, spec in TYPES.items() if spec.section == section}
    if not kinds:
        raise HTTPException(400, "未知数据分类")
    positions = await native_positions(conn, owner, head) if section == "positions" else []
    orders = list(order_entries(head)) if section == "trades" else []
    native_order_ids = [item["tradeId"] for item in head["snapshot"]["orders"]] if head and section == "trades" else []
    queries = []
    params = []
    for kind, spec in kinds.items():
        query = summary_sql(kind, spec)
        params.append(owner)
        if kind == "position" and positions:
            query += sql.SQL(" AND NOT (t.id=ANY(%s))")
            params.append([row["id"] for row in positions])
        if kind in ("appOrder", "appFill", "trade") and native_order_ids:
            query += sql.SQL(" AND NOT ({}::text=ANY(%s))").format(sql.Identifier(spec.key))
            params.append(native_order_ids)
        if market is not None:
            query += sql.SQL(" AND ({})=%s").format(POSITION_FOLDER)
            params.append(market)
        if before:
            query += sql.SQL(" AND ({}, {}, {}::text)<(%s,%s,%s)").format(
                sql.Identifier(spec.at), sql.Literal(kind), sql.Identifier(spec.key))
            params.extend(before)
        queries.append(sql.SQL("({} ORDER BY at DESC,id DESC LIMIT {})").format(query, sql.Literal(LIMIT + 1)))
    rows = await (await conn.execute(sql.SQL("SELECT * FROM ({}) entries ORDER BY at DESC,type DESC,id DESC LIMIT {}").format(
        sql.SQL(" UNION ALL ").join(queries), sql.Literal(LIMIT + 1)), params)).fetchall()
    projected = orders + [position_entry(row) for row in positions if market is None or position_market(row) == market]
    items = [decoded(row) for row in rows] + [row for row in projected if before is None or entry_key(row) < before]
    items.sort(key=entry_key, reverse=True)
    return packed({"items": items[:LIMIT], "next": entry_key(items[LIMIT - 1]) if len(items) > LIMIT else None})


async def detail(conn, owner, kind, identifier, revision=None, head=None):
    if kind == NATIVE_ORDER:
        if head:
            snapshot = head["snapshot"]
            for item in snapshot["orders"]:
                if item["tradeId"] == identifier and item["status"] != "deleted":
                    data = order_projection(item, history=snapshot.get("orderHistory", {}).get(identifier),
                                            order_number=snapshot.get("orderNumbers", {}).get(identifier))
                    links = [{"type": "position", "id": item["recordId"], "field": "record_id"}]
                    return packed({"type": kind, "id": identifier, "data": {**data, "item": item}, "links": links})
        raise HTTPException(404, "找不到本人的这条记录")
    if kind == "position" and identifier in changed_position_ids(head):
        row = next(row for row in await native_positions(conn, owner, head) if row["id"] == identifier)
        if revision is None or revision == row["revision"]:
            return packed({"type": kind, "id": identifier, "data": position_entry(row)["data"], "links": []})
    spec = TYPES.get(kind)
    if not spec:
        raise HTTPException(400, "未知记录类型")
    query = sql.SQL("SELECT (to_jsonb(t) - ARRAY['raw','source_bytes','evidence_raw','authorization_binding','originals','rows']::text[])::text AS data "
                    "FROM {} t WHERE owner_id=%s AND {}::text=%s").format(
        sql.Identifier(spec.table), sql.Identifier(spec.key))
    if condition := native_event_filter(kind):
        query += sql.SQL(" AND ") + condition
    if kind == "appOrder":
        query += sql.SQL(" AND t.status<>'deleted'")
    if kind == "appFill":
        query += sql.SQL(" AND NOT EXISTS (SELECT 1 FROM native_synced_orders o WHERE o.owner_id=t.owner_id "
                         "AND o.order_id=t.trade_id AND o.status='deleted')")
    row = await (await conn.execute(query, (owner, identifier))).fetchone()
    if not row:
        raise HTTPException(404, "找不到本人的这条记录")
    data = decoded(row)["data"]
    if kind == "declaration":
        declaration = await (await conn.execute("SELECT raw::text AS data FROM personal_order_declarations "
                                                "WHERE owner_id=%s AND id::text=%s", (owner, identifier))).fetchone()
        data["registered"] = decoded(declaration)["data"]
    links = [{"type": target, "id": str(data[column]), "field": column}
             for column, target in FORWARD.get(kind, ()) if data.get(column) is not None]
    for target, column in REVERSE.get(kind, ()):
        related = TYPES[target]
        query = sql.SQL("SELECT {}::text AS id FROM {} WHERE owner_id=%s AND {}::text=%s "
                        "ORDER BY {} DESC,{} DESC LIMIT %s").format(
            sql.Identifier(related.key), sql.Identifier(related.table), sql.Identifier(column),
            sql.Identifier(related.at), sql.Identifier(related.key))
        rows = await (await conn.execute(query, (owner, identifier, LIMIT + 1))).fetchall()
        links.extend({"type": target, "id": item["id"], "field": column} for item in rows[:LIMIT])
        if len(rows) > LIMIT:
            data.setdefault("more_related", []).append({"type": target, "field": column})
    if kind == "trade":
        original = await (await conn.execute("SELECT source_id FROM legacy_order_import_links WHERE owner_id=%s AND trade_id::text=%s", (owner, identifier))).fetchall()
        links.extend({"type": "orderFile", "id": str(item["source_id"]), "field": "import_source"} for item in original)
    if kind == "fundReversal":
        origin = await (await conn.execute("SELECT cash_entry_id FROM fund_sources WHERE owner_id=%s AND id=%s", (owner, identifier))).fetchone()
        if origin:
            links.append({"type": "cash", "id": str(origin["cash_entry_id"]), "field": "original_posting"})
    value = {"type": kind, "id": identifier, "data": data, "links": links}
    if kind in ORIGINALS:
        name = ORIGINALS[kind][2] or data["filename"]
        value["file"] = {"name": name}
        if kind == "orderFile" and name.lower().endswith(".xlsx"):
            rows = await (await conn.execute("""
                SELECT jsonb_path_query_array(rows,'$[0 to 49]')::text AS data
                FROM legacy_order_import_sources WHERE owner_id=%s AND id::text=%s
            """, (owner, identifier))).fetchone()
            value["file"]["rows"] = decoded(rows)["data"]
    if kind == "position":
        versions = await (await conn.execute("""
            SELECT revision,action,captured_at FROM portfolio_record_versions WHERE owner_id=%s AND record_id=%s
            ORDER BY revision DESC LIMIT 24
        """, (owner, identifier))).fetchall()
        selected_revision = revision or int(data["revision"])
        selected = await (await conn.execute("""
            SELECT revision,action,captured_at,current_value::text AS data
            FROM portfolio_record_versions WHERE owner_id=%s AND record_id=%s AND revision=%s
        """, (owner, identifier, selected_revision))).fetchone()
        if selected is None:
            if revision:
                raise HTTPException(404, "该版持仓记录未保留")
        else:
            value["version"] = {key: selected[key] for key in ("revision", "action", "captured_at")}
            value["versions"] = versions
            value["data"] = decoded(selected)["data"]
    return packed(value)


def mount_ledger_trace(app, db):
    @app.get("/api/v2/investment-files/original", operation_id="native_investment_file_original")
    @app.get("/api/personal-data-transfer/original", operation_id="personal_ledger_original")
    async def original(request: Request, type: str, id: str):
        try:
            who = await investment_file_actor(request, db)
            assert_expected_account(request, who.id)
            if not id or len(id) > 200:
                raise HTTPException(400, "原件编号无效")
            async with db.connection() as conn, conn.transaction():
                await lock_read_identity(conn, who)
                raw, filename, checksum = await original_file(conn, who.id, type, id)
            name = filename.replace("\\", "/").split("/")[-1] or "original"
            return Response(raw, media_type="application/octet-stream", headers={
                **PRIVATE, "Content-Disposition": "attachment; filename*=UTF-8''" + quote(name, safe=""),
                "X-Content-Type-Options": "nosniff", "X-Alcor-File-Format": file_format(name, raw),
                "X-Alcor-Source-SHA256": checksum,
            })
        except HTTPException as exc:
            return wire_response({"error": exc.detail}, {**PRIVATE, **(exc.headers or {})}, exc.status_code)

    @app.get("/api/v2/investment-files/records", operation_id="native_investment_files_records")
    @app.get("/api/personal-data-transfer/records", operation_id="personal_ledger_records")
    async def read(request: Request, section: str = "", type: str = "", id: str = "",
                   beforeAt: datetime | None = None, beforeType: str = "", beforeId: str = "", revision: int | None = None,
                   groupBy: str = "", market: str | None = None):
        try:
            who = await investment_file_actor(request, db)
            assert_expected_account(request, who.id)
            cursor = (beforeAt, beforeType, beforeId) if beforeAt else None
            if (beforeAt and (beforeAt.tzinfo is None or (beforeType not in TYPES and beforeType != NATIVE_ORDER) or not beforeId)
                    or not beforeAt and (beforeId or beforeType) or len(id) > 200 or len(beforeId) > 200
                    or (not section and not (type and id)) or (section and (type or id))
                    or (groupBy and (groupBy != "market" or section != "positions" or beforeAt or market is not None))
                    or (market is not None and (section != "positions" or not market or len(market) > 64))
                    or (revision is not None and (type != "position" or revision < 1))):
                raise HTTPException(400, "记录或分页参数无效")
            async with db.connection() as conn, conn.transaction():
                await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                await lock_read_identity(conn, who)
                head = await ledger_head(conn, who.id) if section in {"positions", "trades"} or type in {"position", NATIVE_ORDER} else None
                if groupBy:
                    value = await list_position_folders(conn, who.id, head)
                elif section:
                    value = await list_records(conn, who.id, section, cursor, market, head)
                else:
                    value = await detail(conn, who.id, type, id, revision, head)
            return wire_response(value, PRIVATE)
        except HTTPException as exc:
            return wire_response({"error": exc.detail}, {**PRIVATE, **(exc.headers or {})}, exc.status_code)
