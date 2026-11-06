"""Explicit owner feed jobs over the existing task queue and installed licences."""

import hashlib
import ipaddress
import json
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .feed_parse import public_url
from .native_app_auth import CLIENT, active_grant
from .security import lock_mutation_identity


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, default=str, separators=(",", ":")).encode()
    ).hexdigest()


class FeedSources:
    def __init__(self, db):
        self.db = db

    def target(self, owner, target_id):
        rows = [r for r in self.db.settings.feed_targets if r.get("id") == target_id]
        if len(rows) != 1:
            raise HTTPException(503, "此订阅源尚未安装明确许可")
        row = rows[0]
        try:
            if (
                row["ownerId"] != owner
                or str(row["instanceId"]) != str(self.db.settings.instance_id)
                or row["approvedAccess"] is not True
                or (row["provider"], row["purpose"])
                not in {
                    ("rss-atom", "feed.subscription.read"),
                    ("deepseek-search", "feed.search"),("brave-search", "feed.search"),("google-news-rss", "feed.search"),
                    ("publisher-html", "feed.article.read"),
                    ("person-original-json", "feed.person.read"),
                    ("trump-archive-html", "feed.person.read"),
                    ("xueqiu-status-json", "feed.person.read"),
                }
                or (
                    row["provider"] in {"person-original-json", "trump-archive-html", "xueqiu-status-json"}
                    and row.get("personId") not in {"trump", "duan"}
                )
            ):
                raise ValueError()
            if (
                not public_url(row["url"])
                or any(
                    k.lower()
                    in {
                        "token",
                        "key",
                        "secret",
                        "password",
                        "authorization",
                        "apikey",
                        "api_key",
                        "access_token",
                    }
                    for k in parse_qs(urlsplit(row["url"]).query)
                )
                or not row["licenseRevision"]
                or datetime.fromisoformat(row["expiresAt"]) <= datetime.now(UTC)
            ):
                raise ValueError()
            if row['provider']in {'deepseek-search','brave-search','google-news-rss','publisher-html'}:
                from .feed_search import validate
                validate(row)
            parsed = urlsplit(row["url"])
            if row["provider"] == "trump-archive-html" and (
                parsed.hostname != "trumpstruth.org" or row.get("personId") != "trump"
            ):
                raise ValueError()
            if row["provider"] == "xueqiu-status-json" and (
                parsed.hostname != "api.xueqiu.com"
                or parsed.path != "/statuses/user_timeline.json"
                or parse_qs(parsed.query).get("user_id") != ["1247347556"]
                or row.get("personId") != "duan"
                or not row.get("credentialCiphertext")
            ):
                raise ValueError()
            if (
                not isinstance(row["addresses"], list)
                or not 1 <= len(row["addresses"]) <= 32
                or any(not ipaddress.ip_address(ip).is_global for ip in row["addresses"])
            ):
                raise ValueError()
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(503, "订阅源目标、许可或有效期不可用") from exc
        return row

    def targets(self, who):
        result = []
        for configured in self.db.settings.feed_targets:
            try:
                row = self.target(who.id, configured.get("id"))
            except HTTPException:
                continue
            result.append(
                {
                    "id": row["id"],
                    "name": row.get("name", row["id"]),
                    "url": row["url"],
                    "provider": row["provider"],
                    "purpose":row['purpose'],
                    "personId": row.get("personId"),
                    "publicDisplay": row.get("publicDisplay") is True,
                    "licenseRevision": row["licenseRevision"],
                    "expiresAt": row["expiresAt"],
                }
            )
        return {
            "targets": result,
            "state": "available" if result else "unavailable",
            "collectionOnRead": False,
        }

    async def lock(self, conn, who):
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who, require_admin=False)

    async def subject(self, conn, who):
        user = await (
            await conn.execute("SELECT role,session_version FROM users WHERE id=%s", (who.id,))
        ).fetchone()
        if not user or user["role"] != who.role:
            raise HTTPException(403, "账号权限已变化")
        native = getattr(who, "grant_id", None) if getattr(who, "native_client", False) else None
        client = None
        if native:
            grant = await active_grant(conn, native)
            if (
                not grant
                or grant["client_id"] != CLIENT
                or grant["user_id"] != who.id
                or "feed.write" not in grant["scope"].split()
            ):
                raise HTTPException(403, "动态写入授权已变化")
        else:
            session = await (
                await conn.execute(
                    "SELECT client_id FROM sessions WHERE user_id=%s AND token_hash=%s AND expires_at>clock_timestamp() AND session_version=%s",
                    (who.id, who.token_hash, user["session_version"]),
                )
            ).fetchone()
            if not session or session["client_id"] not in {"new-web", "legacy-web", "legacy-v1"}:
                raise HTTPException(403, "需要当前Web会话或明确App动态授权")
            client = session["client_id"]
        return {
            "ownerId": who.id,
            "instanceId": str(self.db.settings.instance_id),
            "role": user["role"],
            "sessionVersion": user["session_version"],
            "nativeGrantId": str(native) if native else None,
            "sessionHash": None if native else who.token_hash,
            "sessionClient": client,
        }

    async def create(self, who, raw, kind, *, legacy=False, source_name=None):
        try:
            rid = str(UUID(raw["requestId"]))
        except (KeyError, ValueError, TypeError, AttributeError) as exc:
            raise HTTPException(400, "原请求UUID无效") from exc
        hashed = fingerprint({"kind":kind,"data":raw,**({'sourceName':source_name}if source_name is not None else{})})
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM feed_source_jobs WHERE owner_id=%s AND request_id=%s", (who.id, rid)
                )
            ).fetchone()
            if prior:
                if prior['fingerprint']!=hashed:
                    # Earlier source-test receipts did not retain the optional
                    # client display name. Preserve that original operation;
                    # never manufacture a new request or call the provider again.
                    compatible=(kind=='source_test'and source_name is not None and 'sourceName'not in prior['inputs']and prior['fingerprint']==fingerprint({'kind':kind,'data':raw}))
                    if not compatible:raise HTTPException(409,'原UUID已用于不同动态来源操作')
                return await self.project(conn, prior)
            subject = await self.subject(conn, who)
            inputs = {**raw}
            group_id = raw.get("groupId")
            revision = raw.get("groupRevision", raw.get("revision"))
            if kind == "source_test":
                if set(raw) != {"requestId", "targetId"}:
                    raise HTTPException(400, "订阅测试字段无效")
                ids = [raw["targetId"]]
                if source_name is not None:
                    from .feed_core import text
                    inputs['sourceName']=text(source_name,60)
                if self.target(who.id,ids[0])['provider']!='rss-atom':raise HTTPException(400,'订阅测试只接受已安装RSS/Atom来源')
            elif kind == "refresh":
                if set(raw) - {
                    "requestId",
                    "groupId",
                    "groupRevision",
                    "targetIds",
                    "scheduled",
                    "modelTargetId",
                } or not {
                    "requestId",
                    "groupId",
                    "groupRevision",
                } <= set(raw):
                    raise HTTPException(400, "刷新参数无效")
                from .feed_core import group_on_connection

                group = await group_on_connection(conn, who.id, group_id)
                if group["revision"] != revision or type(revision) is not int:
                    raise HTTPException(409, "动态组修订已变化")
                people = group.get("mode") == "people"
                from .feed_core import preferences_on_connection

                preferences = await preferences_on_connection(conn, who.id, group_id)
                if "scheduled" in raw and type(raw["scheduled"]) is not bool:
                    raise HTTPException(400, "自动刷新确认无效")
                if raw.get("scheduled") is True:
                    if not preferences["enabled"]:
                        raise HTTPException(409, "须先明确启用此组自动刷新")
                    inputs.update(
                        scheduled=True, intervalMinutes=preferences["intervalMinutes"], scheduleRoot=rid
                    )
                from .feed_model import FeedModel

                models = [
                    item
                    for item in FeedModel(self.db).available(who.id)
                    if item.get("purpose") == ("feed.translate" if people else "feed.compose")
                ]
                model_id = raw.get("modelTargetId")
                legacy_models=models[:2] if legacy and not people and model_id is None else []
                if legacy_models:model_id=legacy_models[0]["id"]
                if model_id is None and len(models) == 1:
                    model_id = models[0]["id"]
                if model_id is not None:
                    model = FeedModel(self.db).target(
                        who.id, model_id, purpose="feed.translate" if people else "feed.compose"
                    )
                    inputs["composeTarget"] = {
                        "id": model_id,
                        "fingerprint": fingerprint(model),
                        "licenseRevision": model["licenseRevision"],
                        "purpose": "feed.translate" if people else "feed.compose",
                    }
                    if len(legacy_models)>1:
                        inputs['composeFallbacks']=[]
                        for candidate in legacy_models[1:]:
                            alternate=FeedModel(self.db).target(who.id,candidate['id'],purpose='feed.compose')
                            inputs['composeFallbacks'].append({'id':candidate['id'],'fingerprint':fingerprint(alternate),'licenseRevision':alternate['licenseRevision'],'purpose':'feed.compose'})
                else:
                    inputs["composeState"] = "unavailable" if not models else "selection_required"
                approved={r['id']:r for r in self.targets(who)['targets']}
                if people:
                    approved={k:v for k,v in approved.items()if v.get('provider')in {'person-original-json','trump-archive-html','xueqiu-status-json'}and v.get('personId')in set(group['people'])}
                    subscriptions={v['url']for v in approved.values()}
                else:
                    subscribed={r['url']for r in group['subscriptions']}
                    approved={k:v for k,v in approved.items()if v.get('purpose')in {'feed.search','feed.article.read'}or v.get('provider')=='rss-atom'and v['url']in subscribed}
                    subscriptions=subscribed
                requested=raw.get('targetIds')
                if requested is not None and(not isinstance(requested,list)or not 1<=len(requested)<=16 or any(not isinstance(k,str)for k in requested)or len(set(requested))!=len(requested)or any(k not in approved for k in requested)):
                    raise HTTPException(400,'请明确选择当前已安装的动态来源')
                if requested is None:
                    requested=[]
                    for url in sorted(subscriptions):
                        matches=[k for k,v in approved.items()if v['url']==url and(people or v.get('provider')=='rss-atom')]
                        if len(matches)!=1:raise HTTPException(503,'每个订阅URL须有唯一已安装本人许可来源')
                        requested.extend(matches)
                    if not people:
                        for provider in ('deepseek-search','brave-search','google-news-rss'):
                            matches=[k for k,v in approved.items()if v['provider']==provider]
                            if len(matches)>1:raise HTTPException(409,'同类检索有多个许可目标，请明确选择')
                            requested.extend(matches)
                        requested.extend([k for k,v in approved.items()if v['provider']=='publisher-html'])
                def selection(k):
                    target=self.target(who.id,k)
                    return {'id':k,'fingerprint':fingerprint(target),'licenseRevision':target['licenseRevision']}
                if people:
                    ids=requested
                else:
                    ids=[k for k in requested if approved[k]['provider']=='rss-atom']
                    searches=[k for k in requested if approved[k]['purpose']=='feed.search']
                    articles=[k for k in requested if approved[k]['purpose']=='feed.article.read']
                    if legacy and 'composeTarget'not in inputs:raise HTTPException(503,'原动态生成所需文本模型尚未安装或须明确选择')
                    if not ids and not searches:raise HTTPException(503,'没有已安装且明确许可的订阅或检索来源')
                    if 'composeTarget'in inputs:
                        ready=await(await conn.execute("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0147_feed_stage_request_evidence.sql') ready")).fetchone()
                        if not ready['ready']:raise HTTPException(503,'动态阶段原件迁移尚未安装')
                        inputs.update(pipelineVersion='feed-news-v1',instructions=preferences['instructions'],
                            searchTargets=[selection(k)for k in searches],articleTargets=[selection(k)for k in articles])
                    elif searches:raise HTTPException(503,'公开话题检索需要已明确许可的规划文本模型')
                if people and(not ids or len(ids)>8):raise HTTPException(400,'请选择1至8个人物来源')
            else:
                if set(raw) != {
                    "requestId",
                    "parentRequestId",
                    "postId",
                    "messageId",
                    "revision",
                    "targetId",
                }:
                    raise HTTPException(400, "讨论作业参数无效")
                try:
                    UUID(str(raw["parentRequestId"]))
                except (ValueError, TypeError) as exc:
                    raise HTTPException(400, "原问题UUID无效") from exc
                from .feed_core import group_on_connection

                post = await (
                    await conn.execute(
                        "SELECT * FROM feed_posts WHERE owner_id=%s AND id=%s", (who.id, raw["postId"])
                    )
                ).fetchone()
                message = await (
                    await conn.execute(
                        "SELECT * FROM feed_messages WHERE owner_id=%s AND id=%s AND post_id=%s AND request_id=%s AND role='user'",
                        (who.id, raw["messageId"], raw["postId"], raw["parentRequestId"]),
                    )
                ).fetchone()
                if not post or not message:
                    raise HTTPException(404, "本人原帖子或问题不存在")
                group_id = post["group_id"]
                group = await group_on_connection(conn, who.id, group_id)
                if type(revision) is not int or revision != group["revision"]:
                    raise HTTPException(409, "讨论分组修订已变化")
                from .feed_model import FeedModel

                model = FeedModel(self.db).target(who.id, raw["targetId"])
                inputs["modelTarget"] = {
                    "id": raw["targetId"],
                    "fingerprint": fingerprint(model),
                    "licenseRevision": model["licenseRevision"],
                }
                if legacy:
                    installed=[v for v in FeedModel(self.db).available(who.id)if v['purpose']=='feed.discussion']
                    ordered=[v for v in installed if v['id']==raw['targetId']]+[v for v in installed if v['id']!=raw['targetId']]
                    inputs['discussionFallbacks']=[]
                    for item in ordered[1:2]:
                        alternate=FeedModel(self.db).target(who.id,item['id'])
                        inputs['discussionFallbacks'].append({'id':item['id'],'fingerprint':fingerprint(alternate),'licenseRevision':alternate['licenseRevision']})
                ids = []
            if kind != "discussion":
                inputs["targets"] = [
                    {
                        "id": key,
                        "fingerprint": fingerprint(self.target(who.id, key)),
                        "licenseRevision": self.target(who.id, key)["licenseRevision"],
                    }
                    for key in ids
                ]
            outstanding = (
                await (
                    await conn.execute(
                        "SELECT count(*) AS n FROM tasks WHERE owner_id=%s AND status IN ('queued','running','cancel_requested')",
                        (who.id,),
                    )
                ).fetchone()
            )["n"]
            if outstanding >= 100:
                raise HTTPException(429, "待执行任务已达上限")
            task_id, job_id = uuid4(), uuid4()
            await conn.execute(
                "INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,%s,'queued',%s)",
                (
                    task_id,
                    who.id,
                    rid,
                    hashed,
                    "feed." + kind,
                    Jsonb({"feedJobId": str(job_id), "groupId": group_id}),
                ),
            )
            await conn.execute(
                "INSERT INTO feed_source_jobs(owner_id,id,request_id,task_id,kind,group_id,group_revision,inputs,subject,fingerprint) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    who.id,
                    job_id,
                    rid,
                    task_id,
                    kind,
                    group_id,
                    revision,
                    Jsonb(inputs),
                    Jsonb(subject),
                    hashed,
                ),
            )
            await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')", (task_id,))
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'feed.job.requested',%s,%s)",
                (who.id, str(job_id), rid),
            )
            return await self.project(
                conn,
                await (
                    await conn.execute(
                        "SELECT * FROM feed_source_jobs WHERE owner_id=%s AND id=%s", (who.id, job_id)
                    )
                ).fetchone(),
            )

    async def test_source(self, who, raw, *, source_name=None):
        return await self.create(who, raw, "source_test",source_name=source_name)

    async def refresh(self, who, raw, *, legacy=False):
        return await self.create(who, raw, "refresh",legacy=legacy)

    async def discuss(self, who, raw, *, legacy=False):
        return await self.create(who, raw, "discussion",legacy=legacy)

    async def project(self, conn, row):
        task = await (
            await conn.execute(
                "SELECT status,error_code,lease_version,started_at,finished_at FROM tasks WHERE id=%s",
                (row["task_id"],),
            )
        ).fetchone()
        results = await (
            await conn.execute(
                "SELECT result FROM feed_source_results WHERE owner_id=%s AND job_id=%s ORDER BY target_key",
                (row["owner_id"], row["id"]),
            )
        ).fetchall()
        return {
            "requestId": str(row["request_id"]),
            "jobId": str(row["id"]),
            "taskId": str(row["task_id"]),
            "kind": row["kind"],
            "groupId": row["group_id"],
            "groupRevision": row["group_revision"],
            "createdAt": row["created_at"].isoformat(),
            "updatedAt": row["updated_at"].isoformat(),
            "timeAuthority": "persisted_feed_job_change",
            "revision": task["lease_version"],
            "revisionAuthority": "task_lease_generation",
            "added": sum(
                r["result"].get("added", 0) for r in results if isinstance(r["result"].get("added"), int)
            )
            if any(isinstance(r["result"].get("added"), int) for r in results)
            else None,
            "addedScope": "observed_completed_sources_only",
            "state": "unknown"
            if task["error_code"] == "feed_task_unknown"
            else row["status"]
            if row["status"] not in {"queued", "running"}
            else task["status"],
            "sources": [r["result"] for r in results]
            or [{"targetId": r["id"], "state": "queued"} for r in row["inputs"].get("targets", [])],
            "result": row["result"],
            "errorCode": task["error_code"],
            "willRetryAutomatically": False,
            "scheduled": row["inputs"].get("scheduled", False),
            "scheduleState": "requires_live_subject_and_targets"
            if row["inputs"].get("scheduled")
            else "not_enabled",
            "intervalMinutes": row["inputs"].get("intervalMinutes"),
            "instructionsApplied": bool(row["result"] and row["result"].get("instructionsApplied")),
            "parentRequestId": row["inputs"].get("parentRequestId"),
        }

    async def operation(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT * FROM feed_source_jobs WHERE owner_id=%s AND request_id=%s", (who.id, rid)
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "动态来源原UUID回执不存在")
            return await self.project(conn, row)

    async def job(self, who, identifier):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT * FROM feed_source_jobs WHERE owner_id=%s AND id=%s", (who.id, identifier)
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "本人动态任务不存在")
            return await self.project(conn, row)

    async def request_original(self,who,identifier):
        async with self.db.connection()as conn,conn.transaction():
            await self.lock(conn,who)
            row=await(await conn.execute('SELECT a.* FROM feed_source_pages p JOIN feed_source_admissions a USING(owner_id,job_id,target_key) WHERE p.owner_id=%s AND p.id=%s',(who.id,identifier))).fetchone()
            if not row:raise HTTPException(404,'本人阶段输入原件不存在')
            if row['input_bytes']is None:raise HTTPException(409,'旧历史未保存阶段输入，不能补造')
            raw=bytes(row['input_bytes'])
            if hashlib.sha256(raw).hexdigest()!=row['input_sha256']:raise HTTPException(409,'阶段输入原件SHA不符')
            return row,raw

    async def original(self, who, identifier):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT * FROM feed_source_pages WHERE owner_id=%s AND id=%s", (who.id, identifier)
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "本人来源原件不存在")
            raw = bytes(row["raw"])
            if hashlib.sha256(raw).hexdigest() != row["raw_sha256"]:
                raise HTTPException(409, "原件SHA核对失败")
            return row, raw

    async def cancel(self, who, identifier):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT * FROM feed_source_jobs WHERE owner_id=%s AND id=%s FOR UPDATE",
                    (who.id, identifier),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "本人动态任务不存在")
            await self.subject(conn, who)
            await conn.execute(
                "UPDATE tasks SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancel_requested' END,finished_at=CASE WHEN status='queued' THEN clock_timestamp() ELSE finished_at END WHERE owner_id=%s AND id=%s AND status IN ('queued','running')",
                (who.id, row["task_id"]),
            )
            return await self.project(conn, row)
