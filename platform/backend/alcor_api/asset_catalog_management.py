"""Versioned public metadata edits over AssetCatalog's one transaction core."""

import asyncio
import hashlib
import json
import math
import re
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .asset_lookup_contract import trim

TYPES = ("stock", "market", "flag", "crypto", "metal", "broker", "group", "icon")
V1_TYPES = ("stock", "market", "flag", "crypto", "metal")


def page_number(value, fallback=1, maximum=1000000):
    try:
        raw = trim(value or "")
        number = (
            int(raw, 0)
            if re.fullmatch(r"0[xX][a-fA-F0-9]+|0[bB][01]+|0[oO][0-7]+", raw)
            else float(raw or "0")
        )
        return min(maximum, math.floor(number)) if math.isfinite(number) and number >= 1 else fallback
    except (ValueError, OverflowError):
        return fallback


def identifier(value):
    if isinstance(value, str) and value.startswith("card:") and len(value) <= 2048 and "\\" not in value and not any(ord(c) < 32 for c in value):
        return value
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9:._-]{1,120}", value):
        raise HTTPException(400, "素材标识无效")
    return value


def public_identity(row):
    kind = row["type"]
    market = (row["market"] or "OTHER").upper() if kind in ("stock", "broker") else ""
    if kind == "broker" and market in ("GROUP", "OTHER"):
        market = "OTHER"
    code = (row["market"] if kind == "market" else row["code"]).upper()
    return kind, market, code


def fingerprint(data):
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode()
    ).hexdigest()


class AssetManagement:
    def __init__(self, catalog, legacy_directory=None, legacy_card_directory=None):
        self.catalog = catalog
        self.legacy_directory = legacy_directory
        self.legacy_card_directory = legacy_card_directory

    async def prior(self, conn, who, request_id, fp):
        row = await (
            await conn.execute(
                "SELECT * FROM asset_catalog_operations WHERE actor_id=%s AND request_id=%s",
                (who.id, request_id),
            )
        ).fetchone()
        if row and row["fingerprint"] != fp:
            raise HTTPException(409, "原请求编号已用于其他素材操作")
        return row["result"] if row else None

    async def version_for_url(self, conn, url, kind):
        if not url:
            return None
        if not isinstance(url, str) or len(url) > 1024:
            raise HTTPException(400, "图片地址无效")
        parsed = urlsplit(url)
        if parsed.scheme or parsed.netloc or not parsed.path.startswith("/uploads/asset/") or parsed.fragment:
            raise HTTPException(409, "请先在共享素材中登记公共图片原件")
        query = parse_qs(parsed.query)
        if set(query) - {"sha256"} or (
            "sha256" in query
            and (len(query["sha256"]) != 1 or not re.fullmatch(r"[a-f0-9]{64}", query["sha256"][0]))
        ):
            raise HTTPException(400, "图片摘要参数无效")
        row = await (
            await conn.execute(
                """SELECT v.id FROM system_asset_versions v LEFT JOIN system_asset_paths p ON p.current_version=v.id
            WHERE v.public_path=%s AND v.kind='asset' AND v.folder=%s
            AND ((%s::text IS NULL AND p.current_version=v.id) OR v.served_sha256=%s) ORDER BY v.created_at DESC LIMIT 1""",
                (parsed.path, kind, query.get("sha256", [None])[0], query.get("sha256", [None])[0]),
            )
        ).fetchone()
        if not row:
            raise HTTPException(409, "请先在共享素材中登记公共图片原件")
        image, _ = await self.catalog.image(conn, str(row["id"]), kind)
        if not image:
            raise HTTPException(409, "公共图片原件缺失或尚未核对")
        return str(row["id"])

    async def write(self, who, request_id, expected, raw, *, restore=False, rename=False, connection=None, broker_market_scope=("US", "HK", "CN")):
        if rename and connection is None:
            # Same identity -> catalog -> system image lock order as camera uploads.
            from .system_assets import SystemAssets
            async with self.catalog.context(who, True) as conn:
                if str(raw.get("id", "")).startswith("card:") or self.legacy_card_directory is not None:
                    await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('card-catalog',0))")
                async with SystemAssets(self.catalog.db).context(who, True, connection=conn):
                    return await self.write(who, request_id, expected, raw, restore=restore, rename=True, connection=conn, broker_market_scope=broker_market_scope)
        if not isinstance(raw, dict) or set(raw) - {
            "id",
            "type",
            "market",
            "code",
            "name",
            "imageVersion",
            "darkImageVersion",
            "brokerMarkets",
            "url",
            "urlDark",
        }:
            raise HTTPException(400, "素材字段无效")
        if type(restore) is not bool:
            raise HTTPException(400, "恢复标记无效")
        fp = fingerprint(["asset-management", expected, raw, restore, rename])
        context = self.catalog.context(who, True) if connection is None else self.catalog.context(who, True, connection=connection)
        async with context as conn:
            if prior := await self.prior(conn, who, request_id, fp):
                return prior
            current = (
                await (await conn.execute("SELECT revision FROM asset_catalog_scope FOR UPDATE")).fetchone()
            )["revision"]
            if type(expected) is not int or expected != current or expected >= 9007199254740990:
                raise HTTPException(409, "公共素材目录已变化，请重新读取")
            legacy = None
            if rename and self.legacy_card_directory is not None:
                from .card_public_assets import CardPublicAssets
                cards = CardPublicAssets(self.catalog.db, self.legacy_card_directory)
                source = await cards.source(raw.get("id"))
                if source is not None:
                    return await self.rename_card(conn, who, request_id, expected, raw, fp, cards, source)
            if rename:
                aid = identifier(raw.get("id"))
                old = await (
                    await conn.execute("SELECT * FROM asset_catalog_entries WHERE id=%s", (aid,))
                ).fetchone()
                if not old and self.legacy_directory is not None:
                    legacy = next((row for row in await self.legacy_directory.entries() if row["id"] == aid and row["type"] in TYPES), None)
                if not old and legacy is None:
                    from .legacy_asset_directory import MARKET_NAMES
                    key = aid.removeprefix("market:")
                    if aid.startswith("market:") and key in MARKET_NAMES and key != "SPX":
                        legacy = {"type": "market", "market": key, "code": key, "fileVariants": []}
                if not old and legacy is None:
                    raise HTTPException(404, "素材不存在")
                row = old or legacy
                kind, market, code = row["type"], row["market"], row["code"]
                name = raw.get("name")
                if not isinstance(name, str) or not trim(name):
                    raise HTTPException(400, "缺少素材名称")
            else:
                kind = raw.get("type")
                if kind not in TYPES:
                    raise HTTPException(409, "此类素材由原领域管理，当前目录仅提供只读投影")
                if any(not isinstance(raw.get(key, ""), str) for key in ("market", "code", "name")):
                    raise HTTPException(400, "素材字段无效")
                market = trim(raw.get("market") or "OTHER").upper()
                code = trim(raw.get("code", "")).upper()
                if kind in ("stock", "market") and not market:
                    raise HTTPException(400, "缺少市场标识")
                if kind not in ("market", "group") and not code:
                    raise HTTPException(400, "缺少素材代码")
                aid = identifier(
                    raw.get("id")
                    or (
                        "market:" + market
                        if kind == "market"
                        else kind + ":" + code
                        if kind in ("flag", "crypto", "metal", "icon") or kind == "broker" and market in ("GROUP", "OTHER")
                        else "broker:" + market + ":" + code
                        if kind == "broker"
                        else "stock:" + market + ":" + code
                    )
                )
                old = await (
                    await conn.execute("SELECT * FROM asset_catalog_entries WHERE id=%s", (aid,))
                ).fetchone()
                name = raw.get("name") or code or market
            tombstone = await (
                await conn.execute(
                    "SELECT * FROM asset_catalog_tombstones WHERE asset_id=%s AND restored_at IS NULL", (aid,)
                )
            ).fetchone()
            if tombstone and not restore:
                raise HTTPException(409, "素材已删除；请显式确认恢复")
            before = dict(old) if old else None
            if old and any(old[k] != v for k, v in (("type", kind), ("market", market), ("code", code))):
                raise HTTPException(409, "素材身份不可改写，请使用新标识")
            light = str(old["light_version"]) if old and old["light_version"] else None
            dark = str(old["dark_version"]) if old and old["dark_version"] else None
            if legacy and legacy["fileVariants"]:
                # Register exact original bytes in the existing immutable store. The source
                # directory stays untouched; new image versions and the label commit together.
                from pathlib import Path
                from .system_assets import SystemAssets
                images = SystemAssets(self.catalog.db)
                for variant in legacy["fileVariants"]:
                    is_dark = variant.get("darkVariant", False)
                    if (is_dark and dark) or (not is_dark and light):
                        continue
                    source = await asyncio.to_thread(self.legacy_directory.read_original, variant["relativePath"])
                    image = await images.apply(conn, who.id, {"kind": "asset", "folder": kind, "market": market, "code": (code if re.fullmatch(r"[A-Z0-9][A-Z0-9._:-]{0,34}", code) else "IMG-" + hashlib.sha256(code.encode()).hexdigest()[:16]) + ("-dark" if is_dark else ""), "name": name}, Path(variant["relativePath"]).name, source, source_original=True)
                    if is_dark:
                        dark = image["version"]
                    else:
                        light = image["version"]
                await conn.execute("UPDATE system_asset_scope SET revision=revision+1 WHERE namespace='system_public'")
            if not rename:
                if "imageVersion" in raw:
                    light = raw["imageVersion"] or None
                elif raw.get("url"):
                    light = await self.version_for_url(conn, raw["url"], kind)
                if "darkImageVersion" in raw:
                    dark = raw["darkImageVersion"] or None
                elif "urlDark" in raw:
                    dark = await self.version_for_url(conn, raw["urlDark"], kind)
            if tombstone:
                await conn.execute(
                    "UPDATE asset_catalog_tombstones SET restored_at=clock_timestamp(),restored_by=%s,restored_request_id=%s WHERE asset_id=%s",
                    (who.id, request_id, aid),
                )
            broker_markets = raw.get("brokerMarkets")
            if broker_markets is not None and (kind != "broker" or not isinstance(broker_markets, list) or len(broker_markets) > len(broker_market_scope) or any(v not in broker_market_scope for v in broker_markets) or len(set(broker_markets)) != len(broker_markets)):
                raise HTTPException(400, "券商市场分类无效")
            entry = {
                "id": aid,
                "type": kind,
                "market": market,
                "code": code,
                "name": name,
                "imageVersion": light,
                "darkImageVersion": dark,
            }
            text = json.dumps(
                {"version": 1, "publicMetadataConfirmed": True, "entries": [entry]},
                ensure_ascii=True,
                separators=(",", ":"),
            )
            action = "restore" if tombstone else "rename" if rename else "upsert"
            result = await self.catalog.import_locked(
                conn,
                who,
                request_id,
                expected,
                hashlib.sha256(text.encode()).hexdigest(),
                text,
                "管理员素材登记",
                managed=action,
                operation_fingerprint=fp,
                broker_markets=broker_markets,
            )
            await self.event(conn, who, request_id, aid, action, before, result["asset"], result)
            return result

    async def event(self, conn, who, request_id, aid, kind, before, after, result):
        # Snapshots use the public projection rather than credentials/actor state.
        if before and "created_at" in before:
            before = {
                **{k: before[k] for k in ("id", "type", "market", "code", "name", "material_state")},
                "imageVersion": str(before["light_version"]) if before["light_version"] else None,
                "darkImageVersion": str(before["dark_version"]) if before["dark_version"] else None,
                "sourceId": str(before["source_id"]),
            }
        await conn.execute(
            "INSERT INTO asset_catalog_management_events(id,actor_id,request_id,asset_id,kind,before_snapshot,after_snapshot,result) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                uuid4(),
                who.id,
                request_id,
                aid,
                kind,
                Jsonb(before) if before is not None else None,
                Jsonb(after) if after is not None else None,
                Jsonb(result),
            ),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
            (who.id, "asset-catalog." + kind, aid, request_id),
        )

    async def rename_card(self, conn, who, request_id, expected, raw, fp, cards, source):
        from pathlib import Path
        from .system_assets import SystemAssets
        name = raw.get("name")
        if not isinstance(name, str) or not trim(name) or len(name) > 120:
            raise HTTPException(400, "请输入 1–120 字的素材名称")
        old = await (await conn.execute("SELECT * FROM card_catalog_public_index WHERE image_path=%s", (source['originalImageUrl'],))).fetchone()
        version = old['image_version'] if old else None
        if version is None:
            directory = self.legacy_directory if source['relativePath'].startswith('asset/') else self.legacy_card_directory
            data = await asyncio.to_thread(directory.read_original, source['relativePath'])
            image = await SystemAssets(self.catalog.db).apply(conn, who.id, {"kind":"asset", "folder":"card", "name":"卡面图片", "code":""}, Path(source['relativePath']).name, data, source_original=True)
            version = image['version']
            await conn.execute("UPDATE system_asset_scope SET revision=revision+1 WHERE namespace='system_public'")
        binding = await cards.bind(conn, who, expected, raw['id'], version, name=trim(name))
        asset = {**source, "name": trim(name), "code": trim(name).upper(), "readOnly": False}
        result = {"requestId": str(request_id), "state":"completed", "revision":binding['revision'], "asset":asset}
        await conn.execute("INSERT INTO asset_catalog_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)", (who.id, request_id, fp, Jsonb(result)))
        await self.event(conn, who, request_id, raw['id'], 'rename', None, asset, result)
        return result

    async def delete(self, who, request_id, expected, aid, *, connection=None, restore=False):
        aid = identifier(aid)
        fp = fingerprint(["asset-restore" if restore else "asset-delete", expected, aid])
        context = self.catalog.context(who, True) if connection is None else self.catalog.context(who, True, connection=connection)
        async with context as conn:
            if prior := await self.prior(conn, who, request_id, fp):
                return prior
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('card-catalog',0))")
            current = (await (await conn.execute("SELECT revision FROM asset_catalog_scope FOR UPDATE")).fetchone())["revision"]
            if type(expected) is not int or expected != current or expected >= 9007199254740990:
                raise HTTPException(409, "公共素材目录已变化，请重新读取")
            row = await (await conn.execute("SELECT * FROM asset_catalog_entries WHERE id=%s", (aid,))).fetchone()
            source = None
            if self.legacy_card_directory is not None:
                from .card_public_assets import CardPublicAssets
                source = await CardPublicAssets(self.catalog.db, self.legacy_card_directory).source(aid)
            legacy = next((r for r in await self.legacy_directory.entries() if r['id'] == aid), None) if self.legacy_directory is not None and row is None and source is None else None
            tombstone = await (await conn.execute("SELECT * FROM asset_catalog_tombstones WHERE asset_id=%s AND restored_at IS NULL", (aid,))).fetchone()
            material = row or source or legacy
            if material and material['type'] == 'market':
                market_alias = 'market:' + (material['market'] or material['code']).upper()
            else:
                from .legacy_asset_directory import MARKET_NAMES
                market_alias = aid if aid.startswith('market:') and aid[7:] in MARKET_NAMES else None
            if restore:
                if not tombstone:
                    raise HTTPException(409, "素材未移除，请重新读取")
                await conn.execute("UPDATE asset_catalog_tombstones SET restored_at=clock_timestamp(),restored_by=%s,restored_request_id=%s WHERE asset_id=%s", (who.id, request_id, aid))
            else:
                await conn.execute("INSERT INTO asset_catalog_tombstones(asset_id,deleted_by,request_id) VALUES(%s,%s,%s) ON CONFLICT(asset_id) DO UPDATE SET deleted_at=clock_timestamp(),deleted_by=excluded.deleted_by,request_id=excluded.request_id,restored_at=NULL,restored_by=NULL,restored_request_id=NULL", (aid, who.id, request_id))
            if market_alias and market_alias != aid:
                if restore:
                    await conn.execute("UPDATE asset_catalog_tombstones SET restored_at=clock_timestamp(),restored_by=%s,restored_request_id=%s WHERE asset_id=%s", (who.id, request_id, market_alias))
                else:
                    await conn.execute("INSERT INTO asset_catalog_tombstones(asset_id,deleted_by,request_id) VALUES(%s,%s,%s) ON CONFLICT(asset_id) DO UPDATE SET deleted_at=clock_timestamp(),deleted_by=excluded.deleted_by,request_id=excluded.request_id,restored_at=NULL,restored_by=NULL,restored_request_id=NULL", (market_alias,who.id,request_id))
            if source is not None:
                await conn.execute("UPDATE card_catalog_public_index SET deleted_at=" + ("NULL" if restore else "clock_timestamp()") + " WHERE image_path=%s", (source['originalImageUrl'],))
            result = {"requestId": str(request_id), "state": "completed", "kind": "restore" if restore else "delete", "id": aid, "deleted": not restore, "alreadyAbsent": row is None and source is None and legacy is None, "revision": current + 1}
            await conn.execute("UPDATE asset_catalog_scope SET revision=revision+1")
            await conn.execute("INSERT INTO asset_catalog_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)", (who.id, request_id, fp, Jsonb(result)))
            await self.event(conn, who, request_id, aid, result['kind'], dict(row) if row else None, None, result)
            return result

    async def web_icons(self, kind, selected):
        from .asset_web_keys import icon_rows, related_icons, stock_codes

        async with self.catalog.context() as conn:
            removed = {r["asset_id"] for r in await (await conn.execute("SELECT asset_id FROM asset_catalog_tombstones WHERE restored_at IS NULL")).fetchall()}
            mapping = {}
            cache = {}
            budget = {"bytes": 0, "verified": set()}
            for item in selected:
                market = item["market"].upper() if kind == "stock" else ""
                codes = stock_codes(market, item["code"]) if kind == "stock" else [item]
                for code in codes:
                    row = await (
                        await conn.execute(
                            """SELECT e.* FROM asset_catalog_entries e WHERE type=%s
                        AND upper(code)=%s AND (%s='flag' OR upper(market)=%s)
                        AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=e.id AND t.restored_at IS NULL)
                        ORDER BY created_at,id LIMIT 1""",
                            (kind, code, kind, market),
                        )
                    ).fetchone()
                    if not row:
                        # Registered absence/deletion is authoritative; filenames cannot restore it.
                        known = await (await conn.execute(
                            "SELECT 1 FROM asset_catalog_entries WHERE type=%s AND upper(code)=%s AND (%s='flag' OR upper(market)=%s) LIMIT 1",
                            (kind, code, kind, market),
                        )).fetchone()
                        candidates = await self.legacy_directory.matching(kind, market, [code]) if self.legacy_directory is not None and not known else []
                        if not candidates:
                            continue
                        candidates = [r for r in candidates if r["id"] not in removed]
                        if not candidates:
                            continue
                        row = candidates[0]
                        asset = await self.legacy_directory.project(row, budget)
                    else:
                        asset = await self.catalog.project(conn, row, cache, budget)
                    if not asset["imageUrl"]:
                        continue
                    if kind == "stock":
                        mapping[row["market"].upper() + ":" + row["code"].upper()] = asset["imageUrl"]
                        mapping[market + ":" + item["code"].upper()] = asset["imageUrl"]
                    else:
                        mapping[code] = asset["imageUrl"]
                    break
            return {"assets": icon_rows(kind, related_icons(mapping) if kind == "stock" else mapping)}

    async def stock_markets(self):
        """Availability is based on verified public images, never market quotes."""
        async with self.catalog.context() as conn:
            removed = {r["asset_id"] for r in await (await conn.execute("SELECT asset_id FROM asset_catalog_tombstones WHERE restored_at IS NULL")).fetchall()}
            rows = await (await conn.execute("SELECT e.* FROM asset_catalog_entries e WHERE type='stock' AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=e.id AND t.restored_at IS NULL) ORDER BY market,code LIMIT 5001")).fetchall()
            if len(rows) > 5000:
                raise HTTPException(503, "股票素材超过核对预算")
            known = {public_identity(row) for row in await (await conn.execute("SELECT type,market,code FROM asset_catalog_entries WHERE type='stock'")).fetchall()}
            legacy = [row for row in await self.legacy_directory.entries() if row['type'] == 'stock' and row['id'] not in removed and public_identity(row) not in known] if self.legacy_directory else []
            available = set(); budget = {'bytes': 0, 'verified': set()}; cache = {}
            for row, readonly in [*[(r, False) for r in rows], *[(r, True) for r in legacy]]:
                market = row['market']
                if market in available:
                    continue
                projected = await self.legacy_directory.project(row, budget) if readonly else await self.catalog.project(conn, row, cache, budget)
                if projected.get('imageUrl'):
                    available.add(market)
            return sorted(available)

    async def listing(
        self,
        *,
        kind=None,
        q="",
        market=None,
        page=1,
        page_size=10,
        clamp=False,
        sort=None,
        direction="asc",
        deleted=False,
        connection=None,
        directory=None,
    ):
        from .card_catalog import published_card_assets

        async with self.catalog.context(connection=connection) as conn:
            removed = {r["asset_id"] for r in await (await conn.execute("SELECT asset_id FROM asset_catalog_tombstones WHERE restored_at IS NULL")).fetchall()}
            rows = await (
                await conn.execute(
                    """SELECT e.* FROM asset_catalog_entries e WHERE (%s::text IS NULL OR type=%s)
                AND (%s::text IS NULL OR market=%s) AND EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=e.id AND t.restored_at IS NULL)=%s
                ORDER BY type,market,code LIMIT 5001""",
                    (kind, kind, market, market, deleted),
                )
            ).fetchall()
            cards = (
                await published_card_assets(conn, limit=5001, include_deleted=deleted)
                if kind in (None, "card")
                else []
            )
            if len(rows) > 5000 or len(cards) > 5000:
                raise HTTPException(503, "素材列表超过读取预算，请缩小分类和筛选范围")
            records = [(row, False) for row in rows] + [
                (card, True) for card in cards if (card["id"] in removed) == deleted and (market is None or card["market"] == market)
            ]
            known_card_ids = {row["id"] for row in cards}
            known_paths = set()
            if self.legacy_card_directory is not None and kind in (None, "card"):
                known_paths = {unquote(row["image_path"]) for row in await (await conn.execute("SELECT image_path FROM card_catalog_public_index")).fetchall()}
                for card in await self.legacy_card_directory.entries():
                    if (card["id"] in removed) == deleted and card["id"] not in known_card_ids and unquote(card["originalImageUrl"]) not in known_paths and (market is None or card["market"] == market):
                        records.append((card, "legacy-card"))
            if self.legacy_directory is not None:
                # Any registered row, including a tombstone, suppresses the filename fallback.
                known_rows = await (await conn.execute("SELECT type,market,code FROM asset_catalog_entries")).fetchall()
                known = {public_identity(r) for r in known_rows}
                for entry in await self.legacy_directory.entries():
                    if entry["type"] == "card" and (entry["id"] in known_card_ids or unquote(entry["legacyPath"]) in known_paths):
                        continue
                    key = public_identity(entry)
                    if (entry["id"] in removed) == deleted and key not in known and (kind is None or entry["type"] == kind) and (market is None or entry["market"] == market):
                        records.append((entry, "legacy-file"))
                        known.add(key)
            if deleted and kind in (None, 'market'):
                from .legacy_asset_directory import MARKET_NAMES
                represented = {r['market'] for r,_ in records if r['type']=='market'}
                for aid in sorted(removed):
                    key = aid.removeprefix('market:')
                    if aid.startswith('market:') and key in MARKET_NAMES and key not in represented:
                        records.append(({'id':aid,'type':'market','market':key,'code':key,'name':MARKET_NAMES[key],'imageUrl':'','readOnly':True},'placeholder'))
            market_counts, removed_count = {}, 0
            if directory is not None:
                removed_count = (await (await conn.execute("SELECT count(*) AS n FROM asset_catalog_tombstones t JOIN asset_catalog_entries e ON e.id=t.asset_id WHERE t.restored_at IS NULL AND e.type=%s", (kind,))).fetchone())["n"]
                registered_ids = {r["id"] for r in await (await conn.execute("SELECT id FROM asset_catalog_entries WHERE type=%s", (kind,))).fetchall()}
                if self.legacy_directory is not None:
                    removed_count += sum(1 for r in await self.legacy_directory.entries() if r["type"] == kind and r["id"] in removed and r["id"] not in registered_ids)
                if kind == "card":
                    removed_count += (await (await conn.execute("SELECT count(*) AS n FROM card_catalog_public_index WHERE deleted_at IS NOT NULL")).fetchone())["n"]
                if kind == "stock" and not deleted:
                    image_budget = {"bytes": 0, "verified": set()}
                    for row, source in records:
                        projected = await self.legacy_directory.project(row, image_budget) if source == "legacy-file" else await self.catalog.project(conn, row, {}, image_budget)
                        if projected.get("imageUrl"):
                            market_counts[row["market"]] = market_counts.get(row["market"], 0) + 1
                selected_market = directory.get("market", "ALL")
                if selected_market != "ALL":
                    records = [(r, source) for r, source in records if selected_market in r.get("material_state", {}).get("brokerMarkets", r.get("brokerMarkets", []))] if kind == "broker" else [(r, source) for r, source in records if r["market"] == selected_market]
            query = trim(q)
            if sort is not None:
                from .asset_web_paging import sqlite_like_contains

                records = [
                    (row, card)
                    for row, card in records
                    if not query
                    or any(sqlite_like_contains(row.get(field, ""), query) for field in ("code", "name", "bank", "market"))
                ]
            else:
                records = [
                    (row, card)
                    for row, card in records
                    if not query
                    or query.upper() in row["code"].upper()
                    or query.upper() in row["name"].upper()
                ]
            records.sort(key=lambda pair: (pair[0]["type"], pair[0]["market"], pair[0]["code"]))
            if sort is not None:
                records.sort(key=lambda pair: pair[0]["code"])
                if sort in ("name", "code"):
                    records.sort(key=lambda pair: pair[0][sort], reverse=direction == "desc")
            if kind == 'flag' and sort in (None, 'rank'):
                from .legacy_asset_directory import REGION_NAMES
                order = {code:index for index,code in enumerate(REGION_NAMES)}
                records.sort(key=lambda pair: order.get(pair[0]['code'].upper(), len(order)))
            if directory is not None and kind == "broker":
                positions = {aid: i for i, aid in enumerate(directory.get("brokerOrder", []))}
                records.sort(key=lambda pair: (positions.get(pair[0]["id"], len(positions)), pair[0]["name"].casefold()))
            if directory is not None and kind == "market":
                positions = {}
                for code in directory.get("marketOrder", []):
                    positions.setdefault(code, len(positions))
                records.sort(key=lambda pair: positions.get(pair[0]["market"], len(positions)))
            elif directory is not None and kind != "broker":
                records.sort(key=lambda pair: pair[0]["code"])
            total = len(records)
            if clamp:
                page = min(page, max(1, math.ceil(total / page_size)))
            selected = records[(page - 1) * page_size : page * page_size]
            cache = {}
            budget = {"bytes": 0, "verified": set()}
            assets = []
            for row, card in selected:
                if card == "placeholder":
                    assets.append(row)
                    continue
                if card == "legacy-card":
                    assets.append(await self.legacy_card_directory.project(row, budget))
                    continue
                if card == "legacy-file":
                    assets.append(await self.catalog.material_display(conn, await self.legacy_directory.project(row, budget), cache, budget))
                    continue
                if not card:
                    assets.append(
                        {**await self.catalog.project(conn, row, cache, budget), "deleted": deleted}
                    )
                    continue
                assets.append(await self.catalog.project_card(conn, row, budget))
            revision = (await (await conn.execute("SELECT revision FROM asset_catalog_scope")).fetchone())[
                "revision"
            ]
            return {
                "assets": assets,
                **({"marketCounts": market_counts, "removedCount": removed_count} if directory is not None else {}),
                "excludedMarkets": sorted(aid[7:] for aid in removed if aid.startswith("market:")),
                "total": total,
                "page": page,
                "pageSize": page_size,
                "revision": revision,
                "coverage": "platform-public-metadata",
                "historicalCoverageKnown": False,
            }
