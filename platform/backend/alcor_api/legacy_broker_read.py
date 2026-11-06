"""App broker reads over owned platform accounts, never provider balances."""

import json
import re
from datetime import UTC
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .broker_accounts import CURRENCIES, broker_account, broker_collection
from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .source_read_access import source_read_lock

PRESETS = json.loads((Path(__file__).parent / "data" / "broker-presets.json").read_text())
# Cash/settlement adapters share this frozen fourteen-currency contract.
LEGACY_CURRENCIES = tuple(c for c in CURRENCIES if c != "CHF")
# Only account metadata gains CHF: the current App's DTO and display model
# accept it, while cash/settlement adapters retain their separate original limits.
ACCOUNT_METADATA_CURRENCIES = CURRENCIES
MARKETS = {
    "US": "USD",
    "HK": "HKD",
    "CN": "CNY",
    "JP": "JPY",
    "KR": "KRW",
    "SG": "SGD",
    "UK": "GBP",
    "DE": "EUR",
    "FR": "EUR",
    "AU": "AUD",
    "CA": "CAD",
    "IN": "INR",
    "TW": "TWD",
    "BR": "BRL",
}


def iso(value):
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def presets(catalog):
    directory = await catalog.directory("broker")
    # A truncated directory cannot establish which matching original was first.
    if directory["partial"]:
        raise HTTPException(503, "券商素材目录暂时无法完整核对")
    result = []
    for preset in PRESETS:
        names = {
            n.lower().replace("证劵", "证券") for n in [preset["id"], preset["name"], *preset["aliases"]]
        }
        match = next(
            (
                row
                for row in directory["assets"]
                if row["code"].lower() in names or row["name"].lower().replace("证劵", "证券") in names
            ),
            None,
        )
        result.append({**preset, "icon": (match.get("imageUrl") or None) if match else None})
    return result


async def account_view(conn, owner, identifier, preset_rows, *, version=2):
    row = await broker_account(conn, owner, identifier)
    if any(c not in ACCOUNT_METADATA_CURRENCIES for c in row["currencies"]):
        raise HTTPException(409, "旧账户协议不支持当前账户币种，请使用平台账户接口")
    records = await (
        await conn.execute(
            "SELECT market,account_market FROM portfolio_records WHERE owner_id=%s AND broker_account_id=%s AND deleted_at IS NULL",
            (owner, identifier),
        )
    ).fetchall()
    used, issues = set(), set()

    def add(currency):
        if currency is None:
            issues.add("unknown_currency")
        else:
            used.add(currency)

    for record in records:
        add(MARKETS.get(record["market"]))
        if record["account_market"]:
            add(MARKETS.get(record["account_market"]))
    references = await (
        await conn.execute(
            "SELECT kind,currency FROM broker_account_references WHERE owner_id=%s AND account_id=%s AND kind NOT IN ('position','connection')",
            (owner, identifier),
        )
    ).fetchall()
    for reference in references:
        add(reference["currency"])
    revision = await (
        await conn.execute("SELECT revision FROM portfolio_record_collections WHERE owner_id=%s", (owner,))
    ).fetchone()
    preset = next((p for p in preset_rows if p["id"] == row["provider_id"]), None)
    return {
        "id": row["id"],
        "name": row["name"],
        "holdingSource": row["holding_source"],
        "providerId": row["provider_id"],
        "accountKind": row["account_kind"],
        "currency": row["currency"],
        "currencies": [c for c in ACCOUNT_METADATA_CURRENCIES if c in set(row["currencies"]) | used],
        "currencyUsage": {
            "complete": False,
            "platformComplete": not issues,
            "historicalCoverageKnown": False,
            "coverageScope": "platform_registered_dependencies",
            "usedCurrencies": sorted(used),
            "recordCollectionRevision": revision["revision"] if revision else 0,
            "issues": sorted(issues),
        },
        "revision": row["revision"],
        "icon": f"/api/v{version}/broker-accounts/{identifier}/icon" if row.get("icon_version") else preset["icon"] if preset else None,
        "iconSource": "custom" if row.get("icon_version") else "preset" if preset else "none",
        "recordGroup": row["name"],
        "recordCount": len(records),
        "createdAt": iso(row["created_at"]),
        "updatedAt": iso(row["updated_at"]),
    }


def mount_legacy_broker_reads(app):
    async def execute(request, version, action, identifier=None):
        headers = {
            "Cache-Control": "no-store, private",
            "Vary": "Authorization",
            "X-Alcor-API-Version": str(version),
            "X-Alcor-Source-Coverage": "platform-only",
        }
        try:
            if version not in (1, 2):
                raise HTTPException(404, "接口不存在")
            db = app.state.db
            try:
                assert_native_origin(request, db.settings)
            except HTTPException:
                raise HTTPException(403, "请求来源不受信任") from None
            if not re.fullmatch(r"Bearer fat_[A-Za-z0-9_-]{43}", request.headers.get("authorization", "")):
                raise HTTPException(401, "需要有效的 App 连接")
            try:
                who, grant = await native_identity(request, db, "portfolio.read")
            except HTTPException as exc:
                if exc.status_code == 401:
                    raise HTTPException(401, "需要有效的 App 连接") from None
                if exc.status_code == 403:
                    raise HTTPException(403, "连接缺少明确授权的范围") from None
                raise
            if grant["client_id"] != CLIENT:
                raise HTTPException(401, "需要有效的 App 连接")
            if request.query_params:
                raise HTTPException(400, "不支持查询参数")
            if identifier is not None and not re.fullmatch(r"ba-[a-f0-9]{24}", identifier):
                raise HTTPException(404, "账户不存在")
            values = await presets(app.state.asset_lookup_catalog)
            async with db.connection() as conn, conn.transaction():
                await source_read_lock(conn, who)
                if action == "presets":
                    value = {"items": values}
                elif action == "detail":
                    value = await account_view(conn, who.id, identifier, values, version=version)
                else:
                    rows = await (
                        await conn.execute(
                            "SELECT id FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL ORDER BY created_at,id",
                            (who.id,),
                        )
                    ).fetchall()
                    value = {
                        "accountId": who.id,
                        "items": [await account_view(conn, who.id, row["id"], values, version=version) for row in rows],
                        "collectionRevision": await broker_collection(conn, who.id),
                    }
            return JSONResponse({"code": 0, "message": "ok", "data": value}, headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse(
                {"code": exc.status_code * 100 + 1, "message": str(exc.detail)},
                status_code=exc.status_code,
                headers=headers,
            )
        except Exception:  # noqa: BLE001 -- legacy boundary must not expose database/input details
            # The old stable failure is intentionally opaque; no input or PG error is logged.
            return JSONResponse(
                {"code": 50001, "message": "账户暂时无法保存或读取"}, status_code=500, headers=headers
            )

    @app.get("/api/v{version}/broker-accounts")
    async def listing(request: Request, version: int):
        return await execute(request, version, "list")

    @app.get("/api/v{version}/broker-accounts/presets")
    async def preset_list(request: Request, version: int):
        return await execute(request, version, "presets")

    @app.get("/api/v{version}/broker-accounts/{accountId}")
    async def detail(request: Request, version: int, accountId: str):
        return await execute(request, version, "detail", accountId)
