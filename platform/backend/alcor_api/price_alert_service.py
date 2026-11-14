"""One PG rule/receipt authority shared by canonical Web and old native adapters."""

import hashlib
import json
from datetime import UTC, datetime
from uuid import UUID, uuid4, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .business_notifications import append, inbox
from .native_app_auth import active_grant, authenticate
from .price_alert_contract import ACTIONS, CHANNELS, millis, rule, uuid
from .security import lock_mutation_identity, lock_read_identity


def stamp(raw):
    return hashlib.sha256(
        json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


class Alerts:
    def __init__(self, db, reader=None, clock=None):
        self.db, self._reader, self.reader_provider = db, reader, None
        if clock is not None and db.settings.environment != "test":
            raise ValueError("fixture_clock_outside_test")
        if getattr(reader, "fixture", False) and db.settings.environment != "test":
            raise ValueError("fixture_source_outside_test")
        self.now = clock or (lambda: datetime.now(UTC))
        from .notification_bindings import Bindings
        from .notification_providers import Providers

        self.providers = Providers(db)
        self.bindings = Bindings(self, self.providers)

    @property
    def reader(self):
        return self.reader_provider() if self.reader_provider is not None else self._reader

    @reader.setter
    def reader(self, value):
        self._reader, self.reader_provider = value, None

    async def authorize_read(self, conn, who):
        # Read locks fence actor revocation through the final private projection.
        # They never initialize notification collections or enqueue work.
        await lock_read_identity(conn, who, require_admin=False)
        if getattr(who, "native_client", False):
            grant = await authenticate(conn, who.native_access_token, "portfolio.read")
            if grant["user_id"] != who.id or grant["id"] != who.grant_id:
                raise HTTPException(401, "读取授权已变化")
        elif not await (
            await conn.execute(
                """SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=%s AND u.id=%s AND u.active AND s.session_version=u.session_version
            AND s.expires_at>clock_timestamp() AND s.client_id='new-web'""",
                (who.token_hash, who.id),
            )
        ).fetchone():
            raise HTTPException(401, "读取授权已变化")

    async def snapshot(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await self.authorize_read(conn, who)
            return await self._snapshot(conn, who.id)

    async def _snapshot(self, conn, owner):
        collection = await (
            await conn.execute("SELECT * FROM price_alert_collections WHERE owner_id=%s", (owner,))
        ).fetchone()
        rows = await (
            await conn.execute(
                "SELECT * FROM price_alert_rules WHERE owner_id=%s AND deleted_at IS NULL ORDER BY activated_at DESC,id",
                (owner,),
            )
        ).fetchall()
        preferences = collection["preferences"] if collection else {"app": True}
        events = await inbox(conn, owner, kinds=["price.alert", "price.alert.test"])
        unread = (
            await (
                await conn.execute(
                    """SELECT count(*) AS n FROM business_notification_events e JOIN business_notification_deliveries d
            ON d.owner_id=e.owner_id AND d.event_id=e.id LEFT JOIN business_notification_reads r ON r.owner_id=e.owner_id AND r.event_id=e.id
            WHERE e.owner_id=%s AND e.kind=ANY(%s) AND d.channel='app' AND d.state='delivered' AND r.event_id IS NULL""",
                    (owner, ["price.alert", "price.alert.test"]),
                )
            ).fetchone()
        )["n"]
        channels = [
            {
                "channel": channel,
                "enabled": preferences.get(channel, False),
                "ready": channel == "app",
                "configured": channel == "app",
                "destination": "App 内" if channel == "app" else "",
                "pendingConfirmation": False,
            }
            for channel in CHANNELS
        ]
        channels = [
            row
            if row["channel"] == "app"
            else {**row, **await self.bindings.state(conn, owner, row["channel"])}
            for row in channels
        ]
        jobs = {}
        if rows:
            for job in await (
                await conn.execute(
                    """SELECT DISTINCT ON (j.rule_id) j.rule_id,j.monitoring_state,t.status
                    FROM price_alert_jobs j JOIN tasks t ON t.id=j.task_id
                    JOIN price_alert_rules r ON r.owner_id=j.owner_id AND r.id=j.rule_id AND r.revision=j.rule_revision
                    WHERE j.owner_id=%s AND r.deleted_at IS NULL
                    ORDER BY j.rule_id,t.created_at DESC""",
                    (owner,),
                )
            ).fetchall():
                jobs[job["rule_id"]] = job
        live_user, live_subscriptions = None, None
        if any(row["state"] == "enabled" for row in rows):
            # One authority snapshot for every enabled rule; grants are still
            # checked per subscription below.
            live_user = await (
                await conn.execute("SELECT active,session_version FROM users WHERE id=%s", (owner,))
            ).fetchone()
            live_subscriptions = {}
            for subscription in await (
                await conn.execute(
                    "SELECT * FROM price_alert_subscriptions WHERE owner_id=%s AND revoked_at IS NULL",
                    (owner,),
                )
            ).fetchall():
                live_subscriptions.setdefault(subscription["rule_id"], []).append(subscription)
        rule_views = []
        for row in rows:
            live = row["state"] != "enabled" or await active_subscriptions(
                conn, row, lock=False, user=live_user,
                subscriptions=(live_subscriptions or {}).get(row["id"], []),
            )
            job = jobs.get(row["id"])
            status = (
                row["state"]
                if live and (not job or job["status"] not in {"cancelled", "failed"})
                else "paused"
            )
            rule_views.append(
                {
                    "rule": row["config"],
                    "revision": row["revision"],
                    "status": status,
                    "monitoringState": job["monitoring_state"] if job else "inactive",
                }
            )
        return {
            "accountId": owner,
            "revision": collection["revision"] if collection else 0,
            "asOf": millis(self.now()),
            "channelRevision": collection["channel_revision"] if collection else 0,
            "channels": channels,
            "rules": rule_views,
            "events": events,
            "unreadCount": unread,
        }

    async def operation(self, who, request_id):
        try:
            request_id = uuid(request_id)
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, "请求编号无效") from exc
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await self.authorize_read(conn, who)
            row = await (
                await conn.execute(
                    "SELECT result FROM price_alert_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "操作回执不存在")
            return row["result"]

    async def mutate(self, who, request_id, raw, negotiated, security_proof=None, *, legacy=False):
        try:
            request_id = uuid(request_id)
            if not isinstance(raw, dict) or raw.get("action") not in ACTIONS:
                raise ValueError()
            action = raw["action"]
            if "channel" in raw and not isinstance(raw["channel"], str):
                raise ValueError()
            allowed = {
                "upsert": {"action", "ruleId", "revision", "rule"},
                "delete": {"action", "ruleId", "revision"},
                "state": {"action", "ruleId", "revision", "state"},
                "channel": {"action", "channel", "enabled", "revision"},
                "test": {"action", "channel"},
                "read": {"action", "eventIds", "allThrough"},
            }
            if action in allowed and raw.keys() - allowed[action]:
                raise ValueError()
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, "提醒操作参数无效") from exc
        if (
            action.startswith(("feishu_", "discord_", "qq_"))
            or raw.get("channel")
            in {
                "feishu",
                "discord",
                "qq",
            }
        ) and negotiated != "messengers-v1":
            raise HTTPException(400, "客户端不支持此绑定操作")
        if (action.startswith("wechat_") or raw.get("channel") == "wechat") and negotiated not in {
            "wechat-v1",
            "messengers-v1",
        }:
            raise HTTPException(400, "客户端不支持此绑定操作")
        operation_error = None
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("price-alert-owner:" + who.id,)
            )
            prior = await (
                await conn.execute(
                    "SELECT request_id FROM price_alert_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if prior:
                raise HTTPException(409, "重复请求，请查询原回执")
            await conn.execute(
                "INSERT INTO price_alert_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING", (who.id,)
            )
            if action not in allowed or action in {"channel", "test"} and raw.get("channel") != "app":
                operation_error = await self.bindings.apply(conn, who, raw, security_proof, legacy=legacy)
            elif action in {"upsert", "delete", "state"}:
                await self._rule_mutation(conn, who, raw)
            elif action == "channel":
                if (
                    raw.get("channel") not in CHANNELS
                    or type(raw.get("enabled")) is not bool
                    or type(raw.get("revision")) is not int
                ):
                    raise HTTPException(400, "通知设置无效")
                pref = await (
                    await conn.execute("SELECT * FROM price_alert_collections WHERE owner_id=%s", (who.id,))
                ).fetchone()
                if pref["channel_revision"] != raw["revision"]:
                    raise HTTPException(409, "通知设置已变化，请刷新核对")
                if raw["channel"] != "app" and raw["enabled"]:
                    raise HTTPException(503, "此通知方式尚未完成配置和本人绑定")
                await conn.execute(
                    "UPDATE price_alert_collections SET preferences=preferences||%s,channel_revision=channel_revision+1 WHERE owner_id=%s",
                    (Jsonb({raw["channel"]: raw["enabled"]}), who.id),
                )
            elif action == "read":
                through, identifiers = raw.get("allThrough"), raw.get("eventIds")
                if through is not None:
                    if type(through) is not int or not 0 < through <= millis(self.now()):
                        raise HTTPException(400, "通知读取范围无效")
                    await conn.execute(
                        """INSERT INTO business_notification_reads(owner_id,event_id)
                        SELECT owner_id,id FROM business_notification_events WHERE owner_id=%s AND kind=ANY(%s)
                        AND created_at<=%s ON CONFLICT DO NOTHING""",
                        (
                            who.id,
                            ["price.alert", "price.alert.test"],
                            datetime.fromtimestamp(through / 1000, UTC),
                        ),
                    )
                else:
                    try:
                        if not isinstance(identifiers, list) or len(identifiers) > 200:
                            raise ValueError()
                        identifiers = [uuid(item) for item in identifiers]
                    except (ValueError, TypeError) as exc:
                        raise HTTPException(400, "通知编号无效") from exc
                    await conn.execute(
                        """INSERT INTO business_notification_reads(owner_id,event_id)
                        SELECT owner_id,id FROM business_notification_events WHERE owner_id=%s AND id=ANY(%s::uuid[])
                        AND kind=ANY(%s) ON CONFLICT DO NOTHING""",
                        (who.id, identifiers, ["price.alert", "price.alert.test"]),
                    )
            else:
                if raw.get("channel") != "app":
                    raise HTTPException(503, "此通知方式尚未配置受信任投递服务")
                now = self.now()
                payload = {
                    "kind": "test",
                    "ruleId": "",
                    "name": "Alcor",
                    "code": "",
                    "market": "",
                    "currency": "",
                    "direction": "above",
                    "target": "0",
                    "price": 0,
                    "session": "",
                    "quoteTime": "",
                    "createdAt": millis(now),
                }
                await append(
                    conn,
                    who.id,
                    "price.alert.test",
                    "price-alert-test:" + request_id,
                    payload,
                    created_at=now,
                )
            await conn.execute(
                "UPDATE price_alert_collections SET revision=revision+1 WHERE owner_id=%s", (who.id,)
            )
            result = {
                "requestId": request_id,
                "state": "failed" if operation_error else "completed",
                "snapshot": await self._snapshot(conn, who.id),
            }
            await conn.execute(
                "INSERT INTO price_alert_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, request_id, stamp(raw), Jsonb(result)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'price-alert.operation',%s,%s)",
                (who.id, raw.get("ruleId", who.id), request_id),
            )
        if operation_error:
            raise HTTPException(400, "验证码不正确")
        return result

    async def _rule_mutation(self, conn, who, raw):
        try:
            identifier = uuid(raw["ruleId"])
            if type(raw.get("revision")) is not int or raw["revision"] < 0:
                raise ValueError()
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(400, "提醒编号或版本无效") from exc
        old = await (
            await conn.execute(
                "SELECT * FROM price_alert_rules WHERE owner_id=%s AND id=%s FOR UPDATE", (who.id, identifier)
            )
        ).fetchone()
        if (old["revision"] if old else 0) != raw["revision"]:
            raise HTTPException(409, "提醒已变化，请刷新后重试")
        now = self.now()
        if raw["action"] == "upsert":
            try:
                parsed = rule(raw["rule"], now)
                if parsed["id"] != identifier:
                    raise ValueError()
            except (ValueError, TypeError, KeyError) as exc:
                raise HTTPException(400, "提醒规则无效") from exc
            if (
                old is None
                and (
                    await (
                        await conn.execute(
                            "SELECT count(*) AS n FROM price_alert_rules WHERE owner_id=%s AND deleted_at IS NULL",
                            (who.id,),
                        )
                    ).fetchone()
                )["n"]
                >= 200
            ):
                raise HTTPException(409, "最多保存200条提醒")
            state = "paused" if old and old["state"] == "paused" else "enabled"
        else:
            if old is None or old["deleted_at"]:
                raise HTTPException(404, "提醒不存在")
            parsed = old["config"]
            state = "deleted" if raw["action"] == "delete" else raw.get("state")
            if (raw['action'] == 'state' and state not in {'enabled','paused'}) or state not in {"enabled", "paused", "deleted"}:
                raise HTTPException(400, "提醒状态无效")
            if state == "enabled" and parsed["expiresAt"] is not None and parsed["expiresAt"] <= millis(now):
                raise HTTPException(409, "提醒已过期，请更改有效期")
        revision = raw["revision"] + 1
        await conn.execute(
            """INSERT INTO price_alert_rules(owner_id,id,revision,account_id,source_identity,config,state,activated_at,deleted_at)
            VALUES(%s,%s,%s,%s,'platform',%s,%s,%s,%s) ON CONFLICT(owner_id,id) DO UPDATE SET revision=excluded.revision,
            config=excluded.config,state=excluded.state,activated_at=excluded.activated_at,last_quote_at=NULL,deleted_at=excluded.deleted_at""",
            (
                who.id,
                identifier,
                revision,
                who.id,
                Jsonb(parsed),
                state,
                now,
                now if state == "deleted" else None,
            ),
        )
        await conn.execute(
            """UPDATE tasks t SET status=CASE WHEN t.status='running' THEN 'cancel_requested' ELSE 'cancelled' END,
            finished_at=CASE WHEN t.status='queued' THEN clock_timestamp() ELSE t.finished_at END FROM price_alert_jobs j
            WHERE j.task_id=t.id AND j.owner_id=%s AND j.rule_id=%s AND t.status IN ('queued','running')""",
            (who.id, identifier),
        )
        # Every revision is authorized by its current actor, never a previous actor's live grant.
        await conn.execute(
            "UPDATE price_alert_subscriptions SET revoked_at=clock_timestamp() WHERE owner_id=%s AND rule_id=%s AND revoked_at IS NULL",
            (who.id, identifier),
        )
        if state != "enabled":
            return
        principal = getattr(who, "grant_id", None) or "platform-web"
        user = await (
            await conn.execute("SELECT session_version FROM users WHERE id=%s", (who.id,))
        ).fetchone()
        await conn.execute(
            """INSERT INTO price_alert_subscriptions(owner_id,rule_id,principal,native_grant_id,session_version)
            VALUES(%s,%s,%s,%s,%s) ON CONFLICT(owner_id,rule_id,principal) DO UPDATE SET session_version=excluded.session_version,revoked_at=NULL""",
            (who.id, identifier, principal, getattr(who, "grant_id", None), user["session_version"]),
        )
        task_id, request_id = uuid4(), uuid5(UUID(identifier), "monitor-revision:" + str(revision))
        await conn.execute(
            """INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload)
            VALUES(%s,%s,%s,%s,'alerts.monitor','queued',%s)""",
            (
                task_id,
                who.id,
                request_id,
                stamp({"rule": identifier, "revision": revision}),
                Jsonb({"ruleId": identifier, "revision": revision}),
            ),
        )
        await conn.execute(
            "INSERT INTO price_alert_jobs(task_id,owner_id,rule_id,rule_revision) VALUES(%s,%s,%s,%s)",
            (task_id, who.id, identifier, revision),
        )
        await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')", (task_id,))


async def active_subscriptions(conn, row, *, lock=True, user=None, subscriptions=None):
    if user is None:
        user = await (
            await conn.execute(
                "SELECT active,session_version FROM users WHERE id=%s" + (" FOR SHARE" if lock else ""),
                (row["owner_id"],),
            )
        ).fetchone()
    if not user or not user["active"]:
        return False
    if subscriptions is None:
        subscriptions = await (
            await conn.execute(
                "SELECT * FROM price_alert_subscriptions WHERE owner_id=%s AND rule_id=%s AND revoked_at IS NULL",
                (row["owner_id"], row["id"]),
            )
        ).fetchall()
    for subscription in subscriptions:
        if subscription["session_version"] != user["session_version"]:
            continue
        grant_id = subscription["native_grant_id"]
        if grant_id is None:
            return True
        if lock:
            await conn.execute("SELECT id FROM identity_app_grants WHERE id=%s FOR SHARE", (grant_id,))
        grant = await active_grant(conn, grant_id)
        if grant and grant["user_id"] == row["owner_id"] and "portfolio.write" in grant["scope"].split():
            return True
    return False
