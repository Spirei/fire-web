"""One owner's ledger, captured from a consistent PostgreSQL snapshot."""

import asyncio
from datetime import UTC, datetime
from hashlib import sha256
from tempfile import SpooledTemporaryFile

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse
from psycopg import sql

from .card_preferences_protocol import wire_response
from .personal_data_transfer import digest, encoded
from .record_file_api import actor
from .security import assert_expected_account, lock_read_identity

FORMAT = "alcor-personal-ledger"
VERSION = 1
MAX_BYTES = 128 * 1024 * 1024
PRIVATE = {"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization"}

# Each section is explicit. Account credentials, sessions and open operation
# previews never form part of a ledger archive.
SECTIONS = {
    "positions": (
        "broker_account_collections", "broker_accounts", "broker_account_references", "broker_icon_versions",
        "watch_group_collections", "watch_groups", "portfolio_record_collections",
        "portfolio_records", "portfolio_record_versions", "portfolio_record_orderings", "portfolio_legacy_ordering",
        "broker_record_scope_claims", "broker_position_transfer_operations",
        "broker_position_transfers", "broker_position_transfer_events",
    ),
    "trades": (
        "trade_operations", "trade_ledger", "trade_registration_contexts",
        "trade_presentation_ids", "native_synced_fills", "native_synced_orders", "personal_order_declarations",
        "internal_order_collections", "internal_orders", "internal_order_contexts",
        "internal_order_actions", "internal_order_families", "internal_order_family_legs",
        "legacy_flat_order_operations", "legacy_order_import_sources", "legacy_order_import_links",
        "dividend_receipts", "dividend_receipt_links", "dividend_announcement_revisions", "dividend_history_evidence",
    ),
    "funds": (
        "cash_ledger_collections", "cash_ledger_operations", "cash_ledger_accounts",
        "cash_ledger_entries", "fund_sources", "fund_source_operations",
        "cash_reconciliation_evidence", "cash_financing_confirmations",
    ),
    "corrections": (
        "trade_amendments", "trade_correction_members", "trade_fee_details",
        "trade_fee_import_evidence", "trade_fee_corrections", "trade_fee_projections",
        "actual_fee_confirmations", "native_actual_fee_confirmations", "fund_source_retirements",
        "legacy_fee_baseline_bindings", "registered_fee_baseline_verifications",
    ),
    "originals": (
        "broker_statement_originals", "broker_statement_imports", "broker_statement_events",
        "broker_statement_positions", "financial_import_sources", "financial_import_links", "financial_import_operations",
        "personal_data_transfer_sources", "personal_legacy_activities", "legacy_source_manifests",
        "registered_fee_baseline_versions", "registered_fee_baseline_heads", "registered_fee_baseline_operations",
        "database_migration_history_imports",
    ),
    "results": ("portfolio_daily_results",),
}
TABLES = tuple(table for tables in SECTIONS.values() for table in tables)

# Originals retain references to infrastructure receipts for provenance. Restoring
# a portable archive never reinstates a source grant or replays a background task.
EXTERNAL_REFERENCES = ("legacy_source_grants", "tasks")


def native_files_discovery():
    return {"version": 1, "path": "/api/v2/investment-files", "read_scope": "portfolio.read"}


async def investment_file_actor(request, db):
    if request.url.path.startswith("/api/v2/investment-files/") and not request.headers.get("authorization", "").startswith("Bearer fat_"):
        raise HTTPException(401, "请通过 App 授权查看")
    return await actor(request, db)


async def capture(db, who):
    output = SpooledTemporaryFile(max_size=2 * 1024 * 1024, mode="w+b")  # noqa: SIM115 -- stream owns the finished file
    checksum = sha256()
    counts = {}

    def write(chunk, *, tables=False):
        if output.tell() + len(chunk) > MAX_BYTES:
            raise HTTPException(413, "完整账本超过单份档案上限，请使用完整备份")
        output.write(chunk)
        if tables:
            checksum.update(chunk)

    try:
        async with db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            stamp = (await (await conn.execute("SELECT transaction_timestamp() AS at")).fetchone())["at"]
            write(b'{"tables":')
            write(b"{", tables=True)
            for table in TABLES:
                if counts:
                    write(b",", tables=True)
                write(encoded(table) + b":[", tables=True)
                # Financial columns keep exact decimal text. Embedded legacy/receipt JSON
                # is serialized by PostgreSQL and is never round-tripped through a float.
                query = sql.SQL("""
                    SELECT (SELECT jsonb_object_agg(key, CASE WHEN jsonb_typeof(value)='number'
                          THEN to_jsonb(value #>> '{{}}') ELSE value END)
                        FROM jsonb_each(to_jsonb(t)))::text AS row
                    FROM public.{} t WHERE owner_id=%s ORDER BY t.ctid
                """).format(sql.Identifier(table))
                count = 0
                async with conn.cursor("personal_ledger_rows") as cursor:
                    await cursor.execute(query, (who.id,))
                    cursor.itersize = 128
                    async for item in cursor:
                        if count:
                            write(b",", tables=True)
                        write(item["row"].encode("utf-8"), tables=True)
                        count += 1
                counts[table] = count
                write(b"]", tables=True)
            write(b"}", tables=True)
        async with db.connection() as conn, conn.transaction():
            await lock_read_identity(conn, who)
        metadata = {
            "format": FORMAT, "version": VERSION, "exportedAt": stamp.astimezone(UTC).isoformat(),
            "ownerId": who.id, "schemaSha256": digest(db.expected_migrations),
            "counts": counts, "tablesSha256": checksum.hexdigest(), "externalReferences": EXTERNAL_REFERENCES,
        }
        write(b',"manifest":' + encoded(metadata) + b"}\n")
        length = output.tell()
        output.seek(0)
        return output, length
    except BaseException:
        output.close()
        raise


def mount_personal_ledger_archive(app, db):
    exports = asyncio.Semaphore(2)

    @app.get("/api/personal-data-transfer/ledger", operation_id="personal_ledger_archive_download")
    async def download(request: Request):
        try:
            who = await actor(request, db)
            assert_expected_account(request, who.id)
            if exports.locked():
                raise HTTPException(429, "账本导出繁忙，请稍后重试")
            async with exports:
                output, length = await capture(db, who)
        except HTTPException as exc:
            return wire_response({"error": exc.detail}, {**PRIVATE, **(exc.headers or {})}, exc.status_code)

        def blocks():
            with output:
                yield from iter(lambda: output.read(128 * 1024), b"")

        filename = f"Alcor-ledger-{datetime.now(UTC).date()}.json"
        return StreamingResponse(blocks(), media_type="application/json", headers={
            **PRIVATE, "Content-Length": str(length), "X-Content-Type-Options": "nosniff",
            "Content-Disposition": f'attachment; filename="{filename}"',
        })
