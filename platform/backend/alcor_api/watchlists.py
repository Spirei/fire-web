"""PG-authoritative watch-group preferences; no broker or portfolio state is inferred."""

import hashlib
import json
import re
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

MARKETS = (("US", "美股"), ("HK", "港股"), ("CN", "A股"), ("SG", "新加坡"), ("JP", "日股"), ("KR", "韩股"))


def name_value(value):
    if not isinstance(value, str):
        raise HTTPException(400, "分组名称需为 1-30 个字符")
    value = value.strip()
    if not value or len(value.encode("utf-16-le")) // 2 > 30 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise HTTPException(400, "分组名称需为 1-30 个字符")
    return value, re.sub(r"\s+", " ", value).lower()


def dto(row):
    return {key: row[key] for key in ("id", "name", "icon", "sort", "visible", "kind", "market", "revision")}


class WatchGroups:
    def __init__(self, db):
        self.db = db

    async def lock(self, conn, owner):
        # Shared identity order prevents closure racing an authorized mutation.
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + owner,))
        user = await (await conn.execute("SELECT active FROM users WHERE id=%s FOR SHARE", (owner,))).fetchone()
        if not user or not user["active"]:
            raise HTTPException(403, "账号不可用")
        await conn.execute("INSERT INTO watch_group_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING", (owner,))
        collection = await (await conn.execute("SELECT revision FROM watch_group_collections WHERE owner_id=%s FOR UPDATE", (owner,))).fetchone()
        return collection["revision"]

    async def seed_markets(self, conn, owner, revision):
        existing = await (await conn.execute("SELECT market FROM watch_groups WHERE owner_id=%s AND kind='market'", (owner,))).fetchall()
        present = {r["market"] for r in existing}
        if len(present) < len(MARKETS):
            revision = revision + 1
            for sort, (market, name) in enumerate(MARKETS):
                if market not in present:
                    await conn.execute(
                        "INSERT INTO watch_groups(owner_id,id,name,name_key,sort,kind,market,revision) VALUES(%s,%s,%s,%s,%s,'market',%s,%s)",
                        (owner, "wg-" + uuid4().hex, name, name.lower(), sort, market, revision),
                    )
            await conn.execute("UPDATE watch_group_collections SET revision=%s WHERE owner_id=%s", (revision, owner))
            return revision
        return revision

    async def list(self, owner, *, authorization=None):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            if authorization is not None:
                from .security import lock_read_identity
                if authorization.id != owner:
                    raise HTTPException(403, "账号不匹配")
                await lock_read_identity(conn, authorization, require_admin=False)
            user = await (await conn.execute("SELECT active,role FROM users WHERE id=%s", (owner,))).fetchone()
            if not user or not user["active"]:
                raise HTTPException(403, "账号不可用")
            if authorization is not None and user["role"] != authorization.role:
                raise HTTPException(403, "账号权限已变化")
            collection = await (await conn.execute("SELECT revision FROM watch_group_collections WHERE owner_id=%s", (owner,))).fetchone()
            rows = await (await conn.execute("SELECT * FROM watch_groups WHERE owner_id=%s AND deleted_at IS NULL ORDER BY sort,created_at,id", (owner,))).fetchall()
            initialized = {r["market"] for r in rows if r["kind"] == "market"} == {m for m,_ in MARKETS}
            return {"groups": [dto(r) for r in rows], "revision": collection["revision"] if collection else 0, "initialized": initialized}

    async def resolve_legacy_id(self, owner, value):
        async with self.db.connection() as conn:
            return await self.resolve_legacy_id_on(conn,owner,value)

    async def resolve_legacy_id_on(self,conn,owner,value):
        direct = await (await conn.execute("SELECT id FROM watch_groups WHERE owner_id=%s AND id=%s", (owner,value))).fetchone()
        installed = await (await conn.execute("SELECT to_regclass('public.watch_group_source_bindings') AS name,EXISTS(SELECT 1 FROM schema_migrations WHERE name='0054_watch_group_source_mapping.sql') AS installed")).fetchone()
        if bool(installed['name'])!=installed['installed']:
            raise HTTPException(503,'分组来源编号映射结构尚未完整可用')
        rows = await (await conn.execute("SELECT target_group_id FROM watch_group_source_bindings WHERE owner_id=%s AND original_group_id=%s", (owner,value))).fetchall() if installed["name"] else []
        targets = {row["target_group_id"] for row in rows}
        if direct:targets.add(direct["id"])
        if len(targets)>1:raise HTTPException(409,"旧分组编号对应多个来源，请核对原编号映射")
        return next(iter(targets)) if targets else value

    async def receipt(self, owner, request_id, *, authorization=None):
        try:
            request_id = UUID(str(request_id))
        except ValueError:
            raise HTTPException(400, "请求编号无效") from None
        async with self.db.connection() as conn, conn.transaction():
            if authorization is not None:
                from .security import lock_mutation_identity
                if authorization.id != owner:
                    raise HTTPException(403, "账号不匹配")
                await lock_mutation_identity(conn, authorization, require_admin=False)
            row = await (await conn.execute("SELECT result FROM watch_group_operations WHERE owner_id=%s AND request_id=%s", (owner, request_id))).fetchone()
        if not row:
            raise HTTPException(404, "操作不存在")
        return row["result"]

    async def mutate(self, owner, action, data, request_id, expected_revision=None, *, authorization=None, legacy_ids=False):
        if action not in {"source-import", "initialize", "create", "update", "delete", "reorder", "assign", "reorder-records", "legacy-reorder", "legacy-assign", "legacy-reorder-records"} or not isinstance(data, dict):
            raise HTTPException(400, "操作无效")
        try:
            request_id = UUID(str(request_id))
        except ValueError:
            raise HTTPException(400, "请求编号无效") from None
        if expected_revision is not None and (type(expected_revision) is not int or expected_revision < 0):
            raise HTTPException(400, "版本无效")
        fingerprint = hashlib.sha256(json.dumps([action, data, expected_revision]+([{"protocol":"legacy-id-mapping-v1"}] if legacy_ids else []), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            revision = await self.lock(conn, owner)
            if authorization is not None:
                from .security import lock_mutation_identity
                if authorization.id != owner:
                    raise HTTPException(403, "账号不匹配")
                await lock_mutation_identity(conn, authorization, require_admin=False)
                current = await (await conn.execute("SELECT role FROM users WHERE id=%s", (owner,))).fetchone()
                if not current or current["role"] != authorization.role:
                    raise HTTPException(403, "账号权限已变化")
            prior = await (await conn.execute("SELECT fingerprint,result FROM watch_group_operations WHERE owner_id=%s AND request_id=%s", (owner, request_id))).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "请求编号已用于其他操作")
                return prior["result"]
            if expected_revision is not None and revision != expected_revision:
                raise HTTPException(409, "分组已变化，请刷新后重试")
            if legacy_ids:
                data=dict(data)
                for key in ('id','groupId'):
                    value=data.get(key)
                    if isinstance(value,str) and value and value!='__all' and not value.startswith('market:'):
                        data[key]=await self.resolve_legacy_id_on(conn,owner,value)
                if action=='legacy-reorder' and isinstance(data.get('order'),list):
                    data['order']=list(dict.fromkeys([await self.resolve_legacy_id_on(conn,owner,value) for value in data['order']]))
                if action=='delete' and not await(await conn.execute('SELECT 1 FROM watch_groups WHERE owner_id=%s AND id=%s',(owner,data.get('id')))).fetchone():
                    raise HTTPException(409,'旧分组编号未有本人映射，不能推断已删除')
            revision = await self.seed_markets(conn, owner, revision)
            next_revision = revision + 1
            result, changed = await self.apply(conn, owner, action, data, next_revision)
            if changed:
                await conn.execute("UPDATE watch_group_collections SET revision=%s WHERE owner_id=%s", (next_revision, owner))
            result.update(revision=next_revision if changed else revision, requestId=str(request_id))
            await conn.execute("INSERT INTO watch_group_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)", (owner, request_id, fingerprint, Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)", (owner, "watch-groups." + action, data.get("id"), request_id))
            return result

    async def apply(self, conn, owner, action, data, revision):
        if action == "source-import":
            return await self.source_import(conn, owner, data, revision)
        if action == "initialize":
            if data:
                raise HTTPException(400, "初始化不接受旧记录、名称映射或金融字段")
            return {"initialized": True}, False
        if action in {"legacy-assign", "legacy-reorder-records"}:
            from .legacy_watchlist_ordering import legacy_assign, legacy_reorder
            if set(data) != {"ids", "groupId"}:
                raise HTTPException(400, "参数无效")
            ids, group = data["ids"], data["groupId"]
            if (not isinstance(ids, list) or len(ids) > 2000 or len(set(ids)) != len(ids)
                    or any(not isinstance(i, str) or not 1 <= len(i) <= 100 for i in ids)
                    or not isinstance(group, str) or len(group) > 100):
                raise HTTPException(400, "参数无效")
            if action == "legacy-assign":
                updated = await legacy_assign(conn, self.db, owner, ids, group)
            else:
                updated = await legacy_reorder(conn, self.db, owner, group, ids)
            return {"updated": updated}, bool(updated)
        if action in {"assign", "reorder-records"}:
            return await self.records(conn, owner, action, data), True
        if action == "create":
            if set(data) != {"name"}:
                raise HTTPException(400, "参数无效")
            return {"group": await self.create_group(conn, owner, data["name"], revision)}, True
        if action in {"reorder", "legacy-reorder"}:
            order = data.get("order")
            if set(data) != {"order"} or not isinstance(order, list) or not 1 <= len(order) <= 100 or any(not isinstance(i, str) or not 1 <= len(i) <= 100 for i in order) or len(set(order)) != len(order):
                raise HTTPException(400, "分组顺序无效")
            rows = await (await conn.execute("SELECT id,sort FROM watch_groups WHERE owner_id=%s AND deleted_at IS NULL ORDER BY sort,created_at,id", (owner,))).fetchall()
            owned = {r["id"] for r in rows}
            if action == "reorder" and any(i not in owned for i in order):
                raise HTTPException(409, "分组已变化，请刷新后重试")
            complete = order if action == "legacy-reorder" else order + [r["id"] for r in rows if r["id"] not in set(order)]
            positions = {r["id"]: r["sort"] for r in rows}
            changed = False
            for sort, group_id in enumerate(complete):
                if group_id in positions and positions[group_id] != sort:
                    changed = True
                    await conn.execute("UPDATE watch_groups SET sort=%s,revision=%s,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s", (sort, revision, owner, group_id))
            return {"updated": sum(i in owned for i in order)}, changed
        group_id = data.get("id")
        if not isinstance(group_id, str) or not 1 <= len(group_id) <= 100:
            raise HTTPException(400, "分组编号无效")
        row = await (await conn.execute("SELECT * FROM watch_groups WHERE owner_id=%s AND id=%s AND deleted_at IS NULL", (owner, group_id))).fetchone()
        if action == "delete":
            if set(data) != {"id"}:
                raise HTTPException(400, "参数无效")
            if not row:
                return {"deleted": False}, False
            if row["kind"] == "market":
                raise HTTPException(400, "市场分组不可删除")
            await conn.execute("UPDATE portfolio_records SET watch_group_id=NULL,watch_group_sort=0,updated_at=clock_timestamp() WHERE owner_id=%s AND watch_group_id=%s AND deleted_at IS NULL", (owner, group_id))
            await conn.execute("UPDATE watch_groups SET deleted_at=clock_timestamp(),updated_at=clock_timestamp(),revision=%s WHERE owner_id=%s AND id=%s", (revision, owner, group_id))
            return {"deleted": True}, True
        if not row:
            raise HTTPException(404, "分组不存在")
        if not set(data) <= {"id", "name", "visible", "icon"}:
            # Icon storage/ownership belongs to the file-service slice; never accept an unchecked URL.
            raise HTTPException(400, "参数无效")
        name, key = name_value(data.get("name", row["name"]))
        visible = data.get("visible", row["visible"])
        if type(visible) is not int or visible not in {-1, 0, 1}:
            raise HTTPException(400, "visible 必须为 -1 / 0 / 1")
        icon = row["icon"]
        if "icon" in data:
            from .watch_group_icons import reference
            icon = await reference(conn, owner, row, data["icon"])
        await self.unique(conn, owner, key, group_id)
        if name == row["name"] and visible == row["visible"] and icon == row["icon"]:
            return {"group": dto(row)}, False
        row = await (await conn.execute("UPDATE watch_groups SET name=%s,name_key=%s,visible=%s,icon=%s,revision=%s,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s RETURNING *", (name, key, visible, icon, revision, owner, group_id))).fetchone()
        return {"group": dto(row)}, True

    async def create_group(self, conn, owner, name, revision, *, identifier=None):
        name, key = name_value(name)
        await self.unique(conn, owner, key)
        identifier = identifier or "wg-" + uuid4().hex
        row = await (await conn.execute(
            "INSERT INTO watch_groups(owner_id,id,name,name_key,sort,kind,revision) SELECT %s,%s,%s,%s,COALESCE(max(sort),-1)+1,'custom',%s FROM watch_groups WHERE owner_id=%s RETURNING *",
            (owner, identifier, name, key, revision, owner),
        )).fetchone()
        return dto(row)

    async def source_import(self, conn, owner, data, revision):
        # This finite action is not admitted by the public GroupMutation enum.
        # The importer builds it solely from a sealed authorized source manifest.
        if set(data) != {"groups", "members"} or not isinstance(data["groups"], list) or not isinstance(data["members"], list) or len(data["groups"]) > 1000 or len(data["members"]) > 50000:
            raise HTTPException(400, "分组来源操作范围无效")
        mapped, changed = {}, False
        for item in data["groups"]:
            if set(item) != {"originalId", "targetId", "name", "kind", "market", "sort", "visible"}:
                raise HTTPException(400, "来源分组字段无效")
            if item["kind"] == "market":
                row = await (await conn.execute("SELECT * FROM watch_groups WHERE owner_id=%s AND kind='market' AND market=%s", (owner, item["market"]))).fetchone()
                if not row or item["targetId"] not in (None, row["id"]):
                    raise HTTPException(409, "来源市场身份已变化")
                identifier = row["id"]
            else:
                if item["kind"] != "custom" or item["market"] or not isinstance(item["targetId"], str) or not re.fullmatch("[A-Za-z0-9_-]{1,100}", item["targetId"]):
                    raise HTTPException(400, "来源自定义分组身份无效")
                identifier = item["targetId"]
                row = await (await conn.execute("SELECT * FROM watch_groups WHERE owner_id=%s AND id=%s AND deleted_at IS NULL", (owner, identifier))).fetchone()
                if row is None:
                    await self.create_group(conn, owner, item["name"], revision, identifier=identifier)
                    changed = True
                elif row["kind"] != "custom":
                    raise HTTPException(409, "来源自定义分组身份已变化")
            _result, updated = await self.apply(conn, owner, "update", {"id": identifier, "name": item["name"], "visible": item["visible"]}, revision)
            changed |= updated
            if type(item["sort"]) is not int or not 0 <= item["sort"] <= 2147483647:
                raise HTTPException(400, "来源分组顺序无效")
            cursor = await conn.execute("UPDATE watch_groups SET sort=%s,revision=%s,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s AND sort<>%s", (item["sort"], revision, owner, identifier, item["sort"]))
            changed |= bool(cursor.rowcount)
            mapped[item["originalId"]] = identifier
        from .portfolio_records import PortfolioRecords
        await PortfolioRecords(self.db).lock(conn, owner)
        applied=[]
        for item in data["members"]:
            if set(item) != {"originalRecordId", "recordId", "groupOriginalId", "sort", "expectedRevision", "sourceOrder", "sourceUpdatedAt"} or type(item["sort"]) is not int or not 0 <= item["sort"] <= 2147483647:
                raise HTTPException(400, "来源成员字段无效")
            target=mapped.get(item["groupOriginalId"]) if item["groupOriginalId"] else None
            if item["groupOriginalId"] and target is None:
                raise HTTPException(409, "来源分组尚无明确映射")
            row=await (await conn.execute("SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL FOR UPDATE", (owner,item["recordId"]))).fetchone()
            if not row or row["revision"] != item["expectedRevision"]:
                raise HTTPException(409, "来源成员对应记录已变化")
            if target:
                group=await (await conn.execute("SELECT kind FROM watch_groups WHERE owner_id=%s AND id=%s", (owner,target))).fetchone()
                if not group or group["kind"] != "custom":raise HTTPException(409, "动态市场组不能写入成员归属")
            if item["sourceOrder"] is not None and (type(item["sourceOrder"]) is not int or not 0 <= item["sourceOrder"] < 50000):
                raise HTTPException(400, "来源成员顺序无效")
            projection=await (await conn.execute("SELECT EXISTS(SELECT 1 FROM portfolio_record_orderings WHERE owner_id=%s AND view_id=%s AND record_id=%s AND sort=%s) AS same_order,EXISTS(SELECT 1 FROM portfolio_legacy_ordering WHERE owner_id=%s AND record_id=%s AND display_timestamp=%s::timestamptz) AS same_time",(owner,target,item["recordId"],item["sourceOrder"],owner,item["recordId"],item["sourceUpdatedAt"]))).fetchone()
            different=row["watch_group_id"]!=target or row["watch_group_sort"]!=(item["sort"] if target else 0) or bool(target and item["sourceOrder"] is not None and not projection["same_order"]) or bool(item["sourceUpdatedAt"] is not None and not projection["same_time"])
            if different:
                await conn.execute("UPDATE portfolio_records SET watch_group_id=%s,watch_group_sort=%s,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s",(target,item["sort"] if target else 0,owner,item["recordId"]))
            if target and item["sourceOrder"] is not None:
                await conn.execute("INSERT INTO portfolio_record_orderings(owner_id,view_id,record_id,sort) VALUES(%s,%s,%s,%s) ON CONFLICT(owner_id,view_id,record_id) DO UPDATE SET sort=excluded.sort",(owner,target,item["recordId"],item["sourceOrder"]))
            if item["sourceUpdatedAt"] is not None:
                await conn.execute("INSERT INTO portfolio_legacy_ordering(owner_id,record_id,display_timestamp) VALUES(%s,%s,%s) ON CONFLICT(owner_id,record_id) DO UPDATE SET display_timestamp=excluded.display_timestamp",(owner,item["recordId"],item["sourceUpdatedAt"]))
            changed |= different
            applied.append({"originalRecordId":item["originalRecordId"],"recordId":item["recordId"],"groupId":target,"state":"applied" if different else "unchanged"})
        return {"groupMap":mapped,"members":applied}, changed

    async def unique(self, conn, owner, key, exclude=""):
        row = await (await conn.execute("SELECT 1 FROM watch_groups WHERE owner_id=%s AND name_key=%s AND id<>%s AND deleted_at IS NULL", (owner, key, exclude))).fetchone()
        if row:
            raise HTTPException(409, "分组已存在")

    async def records(self, conn, owner, action, data):
        if set(data) != {"ids", "groupId", "collectionRevision"}:
            raise HTTPException(400, "参数无效")
        ids, group_id, expected = data["ids"], data["groupId"], data["collectionRevision"]
        if (not isinstance(ids, list) or len(ids) > 2000 or (action == "assign" and not ids)
                or any(not isinstance(i, str) or not 1 <= len(i) <= 100 for i in ids)
                or len(set(ids)) != len(ids) or not isinstance(group_id, str) or len(group_id) > 100
                or type(expected) is not int or expected < 0):
            raise HTTPException(400, "记录分组参数无效")
        from .portfolio_records import PortfolioRecords
        records = PortfolioRecords(self.db)
        current = await records.lock(conn, owner)
        if current != expected:
            raise HTTPException(409, "记录集合已变化，请刷新后重试")
        custom = group_id and not (group_id == "__all" or group_id.startswith("market:"))
        if custom:
            group = await (await conn.execute("SELECT kind FROM watch_groups WHERE owner_id=%s AND id=%s AND deleted_at IS NULL", (owner, group_id))).fetchone()
            if not group or group["kind"] != "custom":
                raise HTTPException(404, "分组不存在或不可分配")
        elif action == "assign" and group_id:
            raise HTTPException(400, "仅自定义分组可分配")
        if action == "assign":
            rows = await (await conn.execute("SELECT id FROM portfolio_records WHERE owner_id=%s AND id=ANY(%s) AND deleted_at IS NULL", (owner, ids))).fetchall()
            if {row["id"] for row in rows} != set(ids):
                raise HTTPException(409, "记录成员已变化，请刷新后重试")
            maximum = await (await conn.execute("SELECT COALESCE(max(watch_group_sort),-1) AS value FROM portfolio_records WHERE owner_id=%s AND watch_group_id=%s AND deleted_at IS NULL", (owner, group_id))).fetchone()
            for index, record_id in enumerate(ids):
                await conn.execute("UPDATE portfolio_records SET watch_group_id=%s,watch_group_sort=%s WHERE owner_id=%s AND id=%s", (group_id or None, maximum["value"] + index + 1 if group_id else 0, owner, record_id))
        else:
            if not group_id:
                raise HTTPException(400, "缺少排序视图")
            if custom:
                rows = await (await conn.execute("SELECT id FROM portfolio_records WHERE owner_id=%s AND watch_group_id=%s AND deleted_at IS NULL", (owner, group_id))).fetchall()
            elif group_id == "__all":
                rows = await (await conn.execute("SELECT id FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL", (owner,))).fetchall()
            else:
                market = group_id[7:]
                if not market or len(market) > 40:
                    raise HTTPException(400, "市场排序视图无效")
                rows = await (await conn.execute("SELECT id FROM portfolio_records WHERE owner_id=%s AND market=%s AND deleted_at IS NULL", (owner, market))).fetchall()
            if {row["id"] for row in rows} != set(ids):
                raise HTTPException(409, "列表成员已变化，请刷新后重试")
            if custom:
                for index, record_id in enumerate(ids):
                    await conn.execute("UPDATE portfolio_records SET watch_group_sort=%s WHERE owner_id=%s AND id=%s", (index, owner, record_id))
            else:
                await conn.execute("DELETE FROM portfolio_record_orderings WHERE owner_id=%s AND view_id=%s", (owner, group_id))
                for index, record_id in enumerate(ids):
                    await conn.execute("INSERT INTO portfolio_record_orderings(owner_id,view_id,record_id,sort) VALUES(%s,%s,%s,%s)", (owner, group_id, record_id, index))
                await conn.execute("UPDATE portfolio_record_collections SET revision=revision+1 WHERE owner_id=%s", (owner,))
        current = await (await conn.execute("SELECT revision FROM portfolio_record_collections WHERE owner_id=%s", (owner,))).fetchone()
        return {"updated": len(ids), "collectionRevision": current["revision"]}
