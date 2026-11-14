"""Explicit public metadata and pinned shared-image references; no directory scans."""

import hashlib
import json
from contextlib import asynccontextmanager
from time import monotonic
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .admin_attachments import iso
from .asset_lookup_contract import image_key, lookup_codes, manifest
from .security import lock_mutation_identity
from .shared_attachment_media import open_original

# Stable image keys are read repeatedly by icon grids. Registry writes clear
# this map; card fallback rows stay uncached so card deletion is immediate.
_original_cache = {}
_ORIGINAL_TTL = 5.0


def invalidate_original_cache():
    _original_cache.clear()


class AssetCatalog:
    def __init__(self, db, legacy_directory=None):
        self.db = db
        self.legacy_directory = legacy_directory

    @asynccontextmanager
    async def connection(self, connection=None):
        if connection is not None:
            yield connection
        else:
            async with self.db.connection() as conn:
                yield conn

    @asynccontextmanager
    async def context(self, who=None, write=False, *, connection=None):
        async with self.connection(connection) as conn, conn.transaction():
            if who:
                await conn.execute(
                    "SELECT pg_advisory_xact_lock" + ("" if write else "_shared") + "(hashtextextended(%s,0))", ("identity-management:" + who.id,)
                )
                await lock_mutation_identity(conn, who, require_admin=True)
                if getattr(who, "legacy_client", False) and not getattr(who, "legacy_platform", False):
                    web = await (
                        await conn.execute(
                            "SELECT 1 FROM sessions WHERE token_hash=%s AND user_id=%s AND client_id='legacy-web'",
                            (who.token_hash, who.id),
                        )
                    ).fetchone()
                    if not web:
                        raise HTTPException(401, "未登录")
            await conn.execute(
                "SELECT pg_advisory_xact_lock"
                + ("" if write else "_shared")
                + "(hashtextextended('asset-lookup-catalog',0))"
            )
            yield conn

    async def image(self, conn, identifier, kind, budget=None):
        if not identifier:
            return None, "metadata-only"
        row = await (
            await conn.execute(
                "SELECT * FROM system_asset_versions WHERE id=%s AND (%s='card' OR (kind='asset' AND folder=%s))",
                (identifier, kind, kind),
            )
        ).fetchone()
        if not row:
            return None, "unregistered-image"
        if budget is not None:
            if row["served_sha256"] in budget["verified"]:
                return row, "registered-shared-image"
            budget["bytes"] += row["served_size"]
            if budget["bytes"] > 64 * 1024 * 1024:
                raise HTTPException(503, "素材原件校验超过读取预算，请缩小批次")
        try:
            stream = await open_original(
                self.db.settings, {"sha256": row["served_sha256"], "byte_length": row["served_size"]}
            )
            stream.close()
        except HTTPException:
            return None, "missing-or-unverified-bytes"
        if budget is not None:
            budget["verified"].add(row["served_sha256"])
        return row, "registered-shared-image"

    async def prepare(self, conn, value):
        results = []
        budget = {"bytes": 0, "verified": set()}
        for item in value["entries"]:
            existing = await (
                await conn.execute(
                    "SELECT type,market,code FROM asset_catalog_entries WHERE id=%s", (item["id"],)
                )
            ).fetchone()
            error = None
            if await (
                await conn.execute(
                    "SELECT 1 FROM asset_catalog_tombstones WHERE asset_id=%s AND restored_at IS NULL",
                    (item["id"],),
                )
            ).fetchone():
                error = "deleted-asset"
            if set(item["aliases"]) & set(item["darkAliases"]):
                error = "alias-conflict"
            if existing and any(existing[k] != item[k] for k in ("type", "market", "code")):
                error = "identity-conflict"
            for variant, field in (("light", "aliases"), ("dark", "darkAliases")):
                key = image_key(item["id"], variant)
                for alias in item[field]:
                    prior = await (
                        await conn.execute("SELECT key FROM asset_catalog_aliases WHERE alias=%s", (alias,))
                    ).fetchone()
                    if prior and prior["key"] != key:
                        error = "alias-conflict"
            # Reject conflicting declarations within this same source before any publication.
            for other in results:
                for field in ("aliases", "darkAliases"):
                    if set(item["aliases"] + item["darkAliases"]) & set(
                        other["entry"]["aliases"] + other["entry"]["darkAliases"]
                    ):
                        error = "alias-conflict"
            light, state = await self.image(conn, item["imageVersion"], item["type"], budget)
            dark, dark_state = await self.image(conn, item["darkImageVersion"], item["type"], budget)
            results.append(
                {
                    "entry": item,
                    "error": error,
                    "light": str(light["id"])
                    if light
                    else item["imageVersion"]
                    if state == "missing-or-unverified-bytes"
                    else None,
                    "dark": str(dark["id"])
                    if dark
                    else item["darkImageVersion"]
                    if dark_state == "missing-or-unverified-bytes"
                    else None,
                    "materialState": {"light": state, "dark": dark_state},
                }
            )
        return results

    async def preview(self, who, text, label):
        value = manifest(text, label)
        async with self.context(who) as conn:
            rows = await self.prepare(conn, value)
            revision = (await (await conn.execute("SELECT revision FROM asset_catalog_scope")).fetchone())[
                "revision"
            ]
            return {
                "sha256": value["sha256"],
                "revision": revision,
                "entryCount": len(rows),
                "publicMetadataConfirmed": True,
                "coverage": "captured-metadata-only",
                "historicalCoverageKnown": False,
                "entries": [
                    {
                        "id": row["entry"]["id"],
                        "state": "rejected" if row["error"] else "ready",
                        "error": row["error"],
                        "materialState": row["materialState"],
                    }
                    for row in rows
                ],
            }

    async def import_source(self, who, identifier, expected, digest, text, label):
        async with self.context(who, True) as conn:
            return await self.import_locked(conn, who, identifier, expected, digest, text, label)

    async def import_locked(
        self, conn, who, identifier, expected, digest, text, label, managed=False, operation_fingerprint=None, broker_markets=None
    ):
        value = manifest(text, label)
        if value["sha256"] != digest:
            raise HTTPException(409, "清单内容已变化，请重新预览")
        fingerprint = (
            operation_fingerprint
            or hashlib.sha256(
                json.dumps([expected, digest, value["sourceLabel"]], ensure_ascii=True).encode()
            ).hexdigest()
        )
        old = await (
            await conn.execute(
                "SELECT * FROM asset_catalog_operations WHERE actor_id=%s AND request_id=%s",
                (who.id, identifier),
            )
        ).fetchone()
        if old:
            if old["fingerprint"] != fingerprint:
                raise HTTPException(409, "原请求编号已用于其他素材操作")
            return old["result"]
        current = (
            await (await conn.execute("SELECT revision FROM asset_catalog_scope FOR UPDATE")).fetchone()
        )["revision"]
        if type(expected) is not int or expected != current or expected >= 9007199254740990:
            raise HTTPException(409, "公共素材目录已变化，请重新预览")
        rows = await self.prepare(conn, value)
        source = uuid4()
        result = {
            "requestId": str(identifier),
            "state": "completed",
            "sourceId": str(source),
            "sha256": digest,
            "revision": current + 1,
            "coverage": "captured-metadata-only",
            "historicalCoverageKnown": False,
            "appliedCount": sum(row["error"] is None for row in rows),
            "rejectedCount": sum(row["error"] is not None for row in rows),
            "entries": [
                {
                    "id": row["entry"]["id"],
                    "state": "rejected" if row["error"] else "applied",
                    "error": row["error"],
                    "materialState": row["materialState"],
                }
                for row in rows
            ],
        }
        await conn.execute(
            "INSERT INTO asset_catalog_sources(id,actor_id,source_label,sha256,original_text,manifest,result) VALUES(%s,%s,%s,%s,%s,%s,%s)",
            (source, who.id, value["sourceLabel"], digest, text, Jsonb(value["entries"]), Jsonb(result)),
        )
        for row in rows:
            if row["error"]:
                continue
            item = row["entry"]
            if item["type"] == "broker":
                prior_state = await (await conn.execute("SELECT material_state FROM asset_catalog_entries WHERE id=%s", (item["id"],))).fetchone()
                categories = broker_markets if broker_markets is not None else (prior_state["material_state"].get("brokerMarkets") if prior_state else None)
                if categories is not None:
                    row["materialState"]["brokerMarkets"] = categories
            await conn.execute(
                """INSERT INTO asset_catalog_entries(id,type,market,code,name,source_id,light_version,dark_version,material_state)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(id) DO UPDATE SET name=excluded.name,source_id=excluded.source_id,
                light_version=excluded.light_version,dark_version=excluded.dark_version,material_state=excluded.material_state,updated_at=clock_timestamp()""",
                (
                    item["id"],
                    item["type"],
                    item["market"],
                    item["code"],
                    item["name"],
                    source,
                    row["light"],
                    row["dark"],
                    Jsonb(row["materialState"]),
                ),
            )
            for variant, field in (("light", "aliases"), ("dark", "darkAliases")):
                key = image_key(item["id"], variant)
                await conn.execute(
                    "INSERT INTO asset_catalog_image_keys(key,asset_id,variant) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
                    (key, item["id"], variant),
                )
                for alias in item[field]:
                    await conn.execute(
                        "INSERT INTO asset_catalog_aliases(alias,key,source_id) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
                        (alias, key, source),
                    )
        await conn.execute("UPDATE asset_catalog_scope SET revision=revision+1")
        if managed:
            if len(rows) != 1 or rows[0]["error"]:
                raise HTTPException(409, "素材身份冲突或已删除，请重新核对")
            saved = await (
                await conn.execute(
                    "SELECT * FROM asset_catalog_entries WHERE id=%s", (rows[0]["entry"]["id"],)
                )
            ).fetchone()
            result = {
                **result,
                "kind": managed,
                "asset": await self.project(conn, saved, {}, {"bytes": 0, "verified": set()},registration_source=getattr(self,'publication_origin','manual')),
            }
        await conn.execute(
            "INSERT INTO asset_catalog_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (who.id, identifier, fingerprint, Jsonb(result)),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'asset-catalog.source.imported',%s)",
            (who.id, identifier),
        )
        return result

    async def receipt(self, who, identifier):
        async with self.context(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM asset_catalog_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, identifier),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原素材操作不存在")
            return row["result"]

    async def source(self, who, identifier):
        async with self.context(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT id,source_label,sha256,original_text,result,created_at FROM asset_catalog_sources WHERE id=%s",
                    (identifier,),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "素材来源不存在")
            return {
                "id": str(row["id"]),
                "sourceLabel": row["source_label"],
                "sha256": row["sha256"],
                "manifestText": row["original_text"],
                "result": row["result"],
                "createdAt": iso(row["created_at"]),
            }

    async def close(self, who, identifier):
        async with self.context(who, True) as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM asset_catalog_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, identifier),
                )
            ).fetchone()
            if row:
                return row["result"]
            result = {"requestId": str(identifier), "state": "closed"}
            await conn.execute(
                "INSERT INTO asset_catalog_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (
                    who.id,
                    identifier,
                    hashlib.sha256(b"closed-asset-catalog-request").hexdigest(),
                    Jsonb(result),
                ),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'asset-catalog.request.closed',%s)",
                (who.id, identifier),
            )
            return result

    async def snapshot(self, who):
        async with self.context(who) as conn:
            revision = (await (await conn.execute("SELECT revision FROM asset_catalog_scope")).fetchone())[
                "revision"
            ]
            sources = await (
                await conn.execute(
                    "SELECT id,source_label,sha256,result,created_at FROM asset_catalog_sources ORDER BY created_at DESC LIMIT 20"
                )
            ).fetchall()
            images = await (
                await conn.execute(
                    "SELECT id,public_path,folder,served_sha256 FROM system_asset_versions WHERE kind='asset' AND folder=ANY(%s) ORDER BY created_at DESC LIMIT 201",
                    (["stock", "market", "flag", "crypto", "metal", "broker", "group"],),
                )
            ).fetchall()
            return {
                "revision": revision,
                "sources": [
                    {
                        "id": str(s["id"]),
                        "sourceLabel": s["source_label"],
                        "sha256": s["sha256"],
                        "createdAt": iso(s["created_at"]),
                        "result": s["result"],
                    }
                    for s in sources
                ],
                "availableImages": [
                    {
                        "id": str(row["id"]),
                        "path": row["public_path"],
                        "type": row["folder"],
                        "sha256": row["served_sha256"],
                    }
                    for row in images[:200]
                ],
                "imagesPartial": len(images) > 200,
            }

    async def directory(self, kind=None):
        from .card_catalog import published_card_assets

        async with self.context() as conn:
            rows = await (
                await conn.execute(
                    "SELECT * FROM asset_catalog_entries e WHERE type=ANY(%s) AND (%s::text IS NULL OR type=%s) AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=e.id AND t.restored_at IS NULL) ORDER BY id LIMIT 201",
                    (["stock", "market", "flag", "crypto", "metal", "broker", "group"], kind, kind),
                )
            ).fetchall()
            cache = {}
            budget = {"bytes": 0, "verified": set()}
            entries = [await self.project(conn, row, cache, budget) for row in rows[:200]]
            cards = await published_card_assets(conn, limit=201) if kind in (None, "card") else []
            for card in cards[:200]:
                entries.append(await self.project_card(conn, card, budget))
            return {
                "assets": entries,
                "partial": len(rows) > 200 or len(cards) > 200,
                "coverage": "platform-public-metadata",
                "historicalCoverageKnown": False,
                "cardSource": "card_catalog_public_index",
            }

    async def project_card(self, conn, card, budget):
        image, state = await self.image(conn, card["imageVersion"], "card", budget)
        return {
            **card,
            "url": image["public_path"] + "?sha256=" + image["served_sha256"] if image else "",
            "imageUrl": "/api/asset-image/" + image_key("card:" + card["url"]) + "?v=" + image["served_sha256"][:12]
            if image
            else "",
            "urlDark": "",
            "imageUrlDark": "",
            "marketCap": None,
            "price": None,
            "changePct": None,
            "lastCheckedAt": "",
            "board": "",
            "materialState": state,
        }

    async def project(self, conn, row, cache, budget, *, registration_source=None):
        result = {
            "id": row["id"],
            "type": row["type"],
            "market": row["market"],
            **({"brokerMarkets": row["material_state"]["brokerMarkets"]} if row["type"] == "broker" and "brokerMarkets" in row["material_state"] else {}),
            "code": row["code"],
            "name": row["name"],
            "source": "manual",
            "marketCap": None,
            "price": None,
            "changePct": None,
            "lastCheckedAt": "",
            "board": "",
            "updatedAt": iso(row["updated_at"]),
            "imageVersion": str(row["light_version"]) if row["light_version"] else None,
            "darkImageVersion": str(row["dark_version"]) if row["dark_version"] else None,
        }
        from .asset_source_evidence import creation_origin
        origin=({'source':registration_source,'sourceKnown':True,'creationAuthority':'current_registration_transaction'}
                if registration_source in ('manual','auto') else await creation_origin(conn,row))
        result.update(origin)
        states = {}
        for variant, field, url_field, image_field in (
            ("light", "light_version", "url", "imageUrl"),
            ("dark", "dark_version", "urlDark", "imageUrlDark"),
        ):
            identifier = str(row[field]) if row[field] else None
            if identifier not in cache:
                cache[identifier] = await self.image(conn, identifier, row["type"], budget)
            image, state = cache[identifier]
            if identifier is None:
                state = row["material_state"].get(variant, "metadata-only")
            states[variant] = state
            result[url_field] = image["public_path"] + "?sha256=" + image["served_sha256"] if image else ""
            result[image_field] = (
                "/api/asset-image/" + image_key(row["id"], variant) + "?v=" + image["served_sha256"][:12]
                if image
                else ""
            )
        from .asset_source_metadata import project as project_metadata

        metadata_key = ("source-metadata", row["id"])
        if metadata_key not in cache:
            cache[metadata_key] = await project_metadata(conn, self.db, row["id"])
        return await self.material_display(conn, {**result, **cache[metadata_key], "materialState": states}, cache, budget)

    async def material_display(self, conn, asset, cache, budget):
        """Preserve the established shared-underlying image rule without changing ETF identity."""
        if asset.get('type') != 'stock' or asset.get('market') != 'US' or asset.get('iconTarget'):
            return asset
        from .asset_web_keys import RELATED
        from .asset_lookup_contract import normalize
        code = normalize('US', asset['code'])
        root = RELATED.get(code)
        if not root:
            return asset
        seen = {code}
        while root in RELATED:
            if root in seen:
                return asset
            seen.add(root); root = RELATED[root]
        cache_key = ('underlying-art', root)
        if cache_key not in cache:
            rows = await (await conn.execute("SELECT * FROM asset_catalog_entries e WHERE type='stock' AND upper(market)='US' AND upper(code)=%s ORDER BY created_at,id LIMIT 1",(root,))).fetchall()
            removed = {r['asset_id'] for r in await (await conn.execute('SELECT asset_id FROM asset_catalog_tombstones WHERE restored_at IS NULL')).fetchall()}
            source = await self.project(conn, rows[0], cache, budget) if rows and rows[0]['id'] not in removed else None
            if not rows and self.legacy_directory is not None:
                original = next((r for r in await self.legacy_directory.matching('stock','US',[root]) if r['id'] not in removed),None)
                source = await self.legacy_directory.project(original,budget) if original else None
            cache[cache_key] = source
        source = cache[cache_key]
        result = {**asset, 'imageInheritance': {'market':'US','code':root}}
        for key in ('url','urlDark','imageUrl','imageUrlDark'):
            result[key] = source.get(key,'') if source else ''
        if source:
            result['iconTarget'] = {k:source[k] for k in ('id','type','market','code','name')}
        return result

    async def lookup(self, keys):
        async with self.context() as conn:
            removed = {r["asset_id"] for r in await (await conn.execute("SELECT asset_id FROM asset_catalog_tombstones WHERE restored_at IS NULL")).fetchall()}
            results = {}
            cache = {}
            budget = {"bytes": 0, "verified": set()}
            missing = []
            for key in keys:
                codes = lookup_codes(key)
                if key["type"] == "stock":
                    clause = "upper(market)=%s AND upper(code)=ANY(%s)"
                    params = (key["market"], codes)
                elif key["type"] == "market":
                    clause = "(upper(market)=%s OR upper(code)=%s)"
                    params = (key["code"], key["code"])
                else:
                    clause = "upper(code)=%s"
                    params = (key["code"],)
                rows = await (
                    await conn.execute(
                        "SELECT * FROM asset_catalog_entries e WHERE NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=e.id AND t.restored_at IS NULL) AND type=%s AND "
                        + clause
                        + " ORDER BY created_at,id LIMIT 201",
                        (key["type"], *params),
                    )
                ).fetchall()
                if len(rows) > 200 or len(results) + len(rows) > 500:
                    raise HTTPException(503, "素材查询超过读取预算")
                if not rows:
                    known = await (await conn.execute(
                        "SELECT 1 FROM asset_catalog_entries WHERE type=%s AND " + clause + " LIMIT 1",
                        (key["type"], *params),
                    )).fetchone()
                    candidates = await self.legacy_directory.matching(key["type"], key.get("market", ""), codes) if self.legacy_directory is not None and not known else []
                    candidates = [r for r in candidates if r["id"] not in removed]
                    for entry in candidates[:1]:
                        results[entry["id"]] = await self.material_display(conn, await self.legacy_directory.project(entry, budget), cache, budget)
                    if not candidates:
                        missing.append(key)
                for row in rows:
                    results[row["id"]] = await self.project(conn, row, cache, budget)
            return {
                "assets": list(results.values()),
                "missingKeys": missing,
                "coverage": "platform-public-metadata",
                "historicalCoverageKnown": False,
            }

    async def resolve_alias(self, url):
        async with self.context() as conn:
            row = await (
                await conn.execute(
                    "SELECT a.key FROM asset_catalog_aliases a JOIN asset_catalog_image_keys k ON k.key=a.key WHERE a.alias=%s AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=k.asset_id AND t.restored_at IS NULL)",
                    (url,),
                )
            ).fetchone()
            return {
                "imageUrl": "/api/asset-image/" + row["key"] if row else None,
                "state": "registered-alias" if row else "missing",
            }

    async def original(self, key):
        cache_key = (str(self.db.settings.instance_id), key)
        cached = _original_cache.get(cache_key)
        if cached is not None and cached[0] > monotonic():
            row = cached[1]
        else:
            async with self.context() as conn:
                row = await (
                    await conn.execute(
                        """SELECT v.* FROM asset_catalog_image_keys k JOIN asset_catalog_entries e ON e.id=k.asset_id
                    JOIN system_asset_versions v ON v.id=CASE WHEN k.variant='light' THEN e.light_version ELSE e.dark_version END
                    WHERE k.key=%s AND v.kind='asset' AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=e.id AND t.restored_at IS NULL) """,
                        (key,),
                    )
                ).fetchone()
                primary = row is not None
                if not row:
                    # Card publication remains owned by its original PG index. The
                    # stable key is a derived projection, never a copied catalog row.
                    row = await (
                        await conn.execute(
                            """SELECT v.* FROM card_catalog_public_index c JOIN system_asset_versions v ON v.id=c.image_version
                        WHERE c.deleted_at IS NULL AND c.image_version IS NOT NULL
                        AND c.asset_lookup_key=%s LIMIT 1""",
                            (key,),
                        )
                    ).fetchone()
                    if not row:
                        raise HTTPException(404, "素材不存在")
            if primary:
                if len(_original_cache) > 2048:
                    _original_cache.clear()
                _original_cache[cache_key] = (monotonic() + _ORIGINAL_TTL, row)
        return row, await open_original(
            self.db.settings, {"sha256": row["served_sha256"], "byte_length": row["served_size"]}
        )
