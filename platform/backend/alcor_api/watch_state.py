"""One PG watch-display authority shared by legacy/native/new-Web adapters."""

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .account_signals import guard
from .native_app_auth import CLIENT
from .watch_state_contract import canonical, mutation, request_id, validate_fields


async def authorized(conn, who, write=False):
    result = await guard(conn, who, "portfolio.write" if write else "portfolio.read")
    if getattr(who, "native_client", False):
        app = await (await conn.execute("SELECT client_id FROM identity_app_grants WHERE id=%s", (who.grant_id,))).fetchone()
        if not app or app["client_id"] != CLIENT:
            raise HTTPException(401, "连接已失效")
    return result


async def snapshot(conn, owner):
    rows = await (await conn.execute("SELECT field,revision,value FROM watch_display_fields WHERE owner_id=%s ORDER BY field COLLATE \"C\"", (owner,))).fetchall()
    return {"version": 1, "userId": owner, "namespace": "watch", "fields": {row["field"]: {"revision": row["revision"], "value": row["value"]} for row in rows}}


class WatchState:
    def __init__(self, db):
        self.db = db

    async def read(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await authorized(conn, who)
            return await snapshot(conn, who.id)

    async def submit(self, who, raw):
        data, hashed = mutation(raw)
        if data["namespace"] != "watch":
            raise HTTPException(409, "费率同步须先完成费率领域预览、版本与原始证据适配")
        async with self.db.connection() as conn, conn.transaction():
            # Same owner lock used by WatchGroups, closure and the existing domain writers;
            # no call to WatchGroups.list/lock that would seed groups during a read.
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,))
            await authorized(conn, who, True)
            fee_sync = await (await conn.execute(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0120_fee_state_sync.sql') AS installed,to_regclass('public.fee_state_operations') IS NOT NULL AS present"
            )).fetchone()
            if fee_sync['installed'] != fee_sync['present']:
                raise HTTPException(503, '费率同步回执结构尚未完整可用')
            if fee_sync['present'] and await (await conn.execute(
                'SELECT 1 FROM fee_state_operations WHERE owner_id=%s AND request_id=%s',
                (who.id, data['requestId']),
            )).fetchone():
                raise HTTPException(409, '原UUID已用于费率同步，请查询原回执')
            prior = await (await conn.execute("SELECT fingerprint,result FROM watch_display_operations WHERE owner_id=%s AND request_id=%s", (who.id, data["requestId"]))).fetchone()
            if prior:
                if prior["fingerprint"] != hashed:
                    raise HTTPException(409, "请求标识已使用")
                return prior["result"]
            old = await snapshot(conn, who.id)
            conflict = any(old["fields"].get(item["key"], {"revision": 0})["revision"] != item["revision"] for item in data["changes"])
            if len(old["fields"]) + sum(item["revision"] == 0 for item in data["changes"]) > 10000:
                raise HTTPException(400, "同步内容过多")
            if not conflict:
                fields = {key: item["value"] for key, item in old["fields"].items()}
                fields.update({item["key"]: item["value"] for item in data["changes"]})
                if len(canonical(fields).encode()) > 4 * 1024 * 1024:
                    raise HTTPException(400, "共享内容超过当前容量")
                validate_fields(fields)
                for item in data["changes"]:
                    await conn.execute("INSERT INTO watch_display_fields(owner_id,field,value,revision) VALUES(%s,%s,%s,1) "
                        "ON CONFLICT(owner_id,field) DO UPDATE SET value=excluded.value,revision=watch_display_fields.revision+1,updated_at=clock_timestamp()",
                        (who.id, item["key"], Jsonb(item["value"]) if item["value"] is not None else None))
            current = await snapshot(conn, who.id)
            keys = {item["key"] for item in data["changes"]}
            result = {"requestId": data["requestId"], "userId": who.id, "namespace": "watch", "state": "conflict" if conflict else "completed", "code": 40902 if conflict else 0,
                "message": "其他设备已修改相同内容，请核对后再保存" if conflict else "ok",
                "data": {**current, "partial": True, "fields": {key: value for key, value in current["fields"].items() if key in keys}}}
            await conn.execute("INSERT INTO watch_display_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)", (who.id, data["requestId"], hashed, Jsonb(result)))
            return result

    async def receipt(self, who, identifier):
        identifier = request_id(identifier)
        async with self.db.connection() as conn, conn.transaction():
            await authorized(conn, who)
            result = await (await conn.execute("SELECT result FROM watch_display_operations WHERE owner_id=%s AND request_id=%s", (who.id, identifier))).fetchone()
            if not result:
                raise HTTPException(404, "同步回执尚未找到")
            return result["result"]
