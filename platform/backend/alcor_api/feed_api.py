"""Feed transports share one owner authority and explicit durable source jobs."""

import asyncio
import base64
import json
import re
from inspect import Parameter, Signature
from datetime import datetime
from uuid import UUID, uuid4, uuid5

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from .feed_core import FeedService, authorize, group_on_connection, stamp, subscriptions
from .feed_model import FeedModel
from .feed_sources import FeedSources
from .fx_provider_parser import unique
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, native_identity, web_identity
from .market_worker import Bound
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .feed_media import avatar_mime
from .resource_media import ResourceMedia
from .security import COOKIE, digest, identity
from .legacy_optional_credentials import credentials_present


async def feed_identity(request, db, *, version=None, write=False):
    if version is not None or "authorization" in request.headers or COOKIE not in request.cookies:
        credentials_present(request)
    assert_native_origin(request, db.settings)
    header = request.headers.get("authorization")
    if version == 2 or header is not None and header.startswith("Bearer fat_"):
        who, grant = await native_identity(request, db, "feed.write" if write else "feed.read")
        if grant["client_id"] != CLIENT:
            raise HTTPException(401, "连接已失效，请重新连接")
        return who
    if version == 1:
        return (await web_identity(request, db, allow_v1_bearer=True))[0]
    if header is not None:
        raise HTTPException(401, "动态凭据无效")
    # Canonical Web has its own session realm; stale legacy cookies may coexist across ports.
    if COOKIE in request.cookies:
        return await identity(request)
    if request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE):
        return (await web_identity(request, db))[0]
    return await identity(request)


def operation_id(request, raw, *, legacy):
    body = raw.pop("requestId", None)
    header = request.headers.get("x-alcor-request-id")
    if body is not None and header is not None and body != header:
        raise HTTPException(400, "原请求编号不一致")
    supplied = body if body is not None else header
    if supplied is None and not legacy:
        raise HTTPException(400, "需要保存原请求UUID")
    try:
        parsed = UUID(supplied) if isinstance(supplied, str) else uuid4() if supplied is None else None
        if parsed is None:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(400, "原请求UUID无效") from None
    return str(parsed), supplied is not None


def legacy_job(value):
    state = value.get("state")
    status = {
        "queued": "queued", "running": "searching", "succeeded": "done", "done": "done",
        "observed": "done", "complete": "done", "cancelled": "error",
        "failed": "error", "partial": "error", "unknown": "error",
    }.get(state, "error")
    return {
        **value, "id": value["jobId"], "status": status,
        "revision":value.get('groupRevision'),"revisionAuthority":"group_preferences_revision",'statusRevision':value.get('revision'),
        "error": value.get("error") or (
            "结果尚未完整核对，请读取原任务；未自动重复请求" if status == "error" else None
        ),
    }


class FeedTransport:
    def __init__(self, app, db):
        self.app, self.db = app, db
        self.core, self.sources, self.models = FeedService(db), FeedSources(db), FeedModel(db)

    async def json_body(self, request, legacy):
        if not legacy and request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            raise HTTPException(415, "请提交JSON内容")
        try:
            value = json.loads(
                await bounded_body(request, 20000 if legacy else 65536),
                object_pairs_hook=unique,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
            )
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, "动态JSON内容无效") from None
        if not isinstance(value, dict):
            raise HTTPException(400, "动态内容须为对象")
        return value

    async def group_revision(self, who, group_id):
        async with self.db.connection() as conn, conn.transaction():
            await authorize(conn, who, True)
            return (await group_on_connection(conn, who.id, group_id))["revision"]

    async def jobs(self, who, group_id, cursor):
        after_time = after_id = None
        if cursor:
            try:
                if len(cursor) > 1024:
                    raise ValueError()
                owner, group, when, identifier = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
                if owner != who.id or group != group_id:
                    raise ValueError()
                after_time, after_id = datetime.fromisoformat(when), UUID(identifier)
                if after_time.tzinfo is None:
                    raise ValueError()
            except (ValueError, TypeError, UnicodeError):
                raise HTTPException(400, "动态任务游标无效") from None
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await self.sources.lock(conn, who)
            rows = await (await conn.execute(
                """SELECT * FROM feed_source_jobs WHERE owner_id=%s AND group_id=%s
                AND (%s::timestamptz IS NULL OR (created_at,id)<(%s::timestamptz,%s::uuid))
                ORDER BY created_at DESC,id DESC LIMIT 21""",
                (who.id, group_id, after_time, after_time, after_id),
            )).fetchall()
            selected = rows[:20]
            values = [await self.sources.project(conn, row) for row in selected]
            last = selected[-1] if selected else None
            next_cursor = base64.urlsafe_b64encode(json.dumps(
                [who.id, group_id, stamp(last["created_at"]), str(last["id"])],
                separators=(",", ":"),
            ).encode()).decode().rstrip("=") if last and len(rows) > 20 else None
            return {"jobs": values, "nextCursor": next_cursor}

    async def wait_job(self,who,result):
        for _ in range(6):
            if result.get('state')not in {'queued','running'}:break
            await asyncio.sleep(0.05)
            result=await self.sources.job(who,UUID(result['jobId']))
        return result

    async def receipt(self, who, rid):
        rid = str(UUID(rid))
        try:
            value = await self.core.receipt(who, rid)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            return await self.sources.operation(who, rid)
        result = value.get("result", {})
        if isinstance(result, dict) and result.get("messageId") and result.get("postId"):
            value = {**value}
            try:
                value["replyJob"] = await self.sources.operation(who, str(uuid5(UUID(rid), "discussion")))
                value["replyState"] = value["replyJob"]["state"]
                if value['replyState']=='succeeded':value['messages']=(await self.core.discussion(who,result['postId']))['messages']
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                value["replyState"] = "unavailable" if result.get("replyModelTargetId") else "not_requested"
        return value

    async def upload(self, request, who, *, legacy):
        await bounded_body(request, 2 * 1024 * 1024 + 65536)
        try:
            form = await request.form(max_files=1, max_fields=3, max_part_size=2 * 1024 * 1024)
            if set(form) - {"file", "revision", "requestId"} or any(len(form.getlist(k)) != 1 for k in form):
                raise HTTPException(400, "动态形象表单无效")
            file, revision = form.get("file"), form.get("revision")
            if not isinstance(file, UploadFile) or not isinstance(revision, str) or not revision.isascii() or not revision.isdecimal() or len(revision) > 16:
                raise HTTPException(400, "请选择图片并提供当前修订")
            raw = await file.read(2 * 1024 * 1024 + 1)
            await file.close()
            if len(raw) > 2 * 1024 * 1024:
                raise HTTPException(413, "动态形象最大2MB")
            await asyncio.to_thread(avatar_mime, raw, file.filename)
            rid, tracked = operation_id(request, {"requestId": form.get("requestId")} if form.get("requestId") else {}, legacy=legacy)
            async with self.db.connection() as conn, conn.transaction():
                await authorize(conn, who, True)
                sha = await ResourceMedia(self.db.settings).stage(conn, who.id, raw)
                service = FeedService(Bound(conn, self.db.settings))
                result = await service.mutate(who, rid, "profile.avatar", {"revision": int(revision), "sha256": sha})
            return result, rid, tracked
        except StarletteHTTPException as exc:
            raise HTTPException(exc.status_code, "动态图片格式无效或超过限制") from None

    async def execute(self, request, action="", *, version=None):
        legacy = version is not None
        headers = {"Cache-Control": "no-store, private", "Vary": "Cookie, Authorization"}
        if legacy:
            headers["X-Alcor-API-Version"] = str(version)
        try:
            write = request.method not in {"GET", "HEAD"}
            who = await feed_identity(request, self.db, version=version, write=write)
            if not await self.app.state.rate_limit(self.db, digest("feed-api:" + who.id), 180, window_seconds=60):
                raise HTTPException(429, "请求过于频繁")
            params = request.query_params
            if any(len(params.getlist(key)) != 1 for key in params):
                raise HTTPException(400, "动态查询参数重复")
            if not legacy and set(params) - {"group", "cursor", "limit", "author", "includeHidden"}:
                raise HTTPException(400, "动态查询参数无效")
            group = params.get("group", "default")
            parts = action.split("/") if action else []
            result = None
            rid = None
            if request.method == "GET":
                if not parts:
                    raw_limit = params.get("limit", "10")
                    if not raw_limit.isascii() or not raw_limit.isdecimal() or len(raw_limit) > 2:
                        raise HTTPException(400, "每页条数为1至50")
                    hidden = params.get("includeHidden", "false")
                    if hidden not in {"true", "false", "1", "0"}:
                        raise HTTPException(400, "隐藏动态筛选无效")
                    result = await self.core.list(who, cursor=params.get("cursor"), limit=int(raw_limit), group_id=group, author=params.get("author"), include_hidden=hidden in {"true", "1"})
                    available = self.sources.targets(who)
                    models = self.models.available(who.id)
                    result["capabilities"].update(
                        generate=bool(available.get("targets")),
                        discussion=any(row["purpose"] == "feed.discussion" for row in models),
                        editPeopleAvatars=who.role == "admin",
                    )
                elif parts == ["groups"]:
                    result = await self.core.groups(who)
                elif parts == ["profile"]:
                    result = await self.core.profile(who)
                elif parts == ["preferences"]:
                    result = await self.core.preferences(who, group)
                elif parts == ["targets"]:
                    result = {**self.sources.targets(who), "modelTargets": self.models.available(who.id)}
                elif parts == ["jobs"]:
                    result = await self.jobs(who, group, params.get("cursor"))
                    if legacy:
                        result["jobs"] = [legacy_job(row) for row in result["jobs"]]
                elif len(parts) == 2 and parts[0] == "jobs":
                    result = await self.sources.job(who, UUID(parts[1]))
                    if legacy:
                        result = legacy_job(result)
                elif len(parts) == 2 and parts[0] == "posts":
                    result = await self.core.post(who, parts[1])
                elif len(parts) == 3 and parts[0] == "posts" and parts[2] == "discussion":
                    result = await self.core.discussion(who, parts[1])
                elif len(parts) == 2 and parts[0] == "operations" and not legacy:
                    result = await self.receipt(who, parts[1])
                elif len(parts)==3 and parts[0]=='originals'and parts[2]=='request'and not legacy:
                    row,raw=await self.sources.request_original(who,UUID(parts[1]))
                    return Response(raw,media_type='application/json',headers={**headers,'Content-Disposition':'attachment; filename="feed-stage-input.json"','X-Content-SHA256':row['input_sha256'],'X-Content-Type-Options':'nosniff'})
                elif len(parts) == 2 and parts[0] == "originals" and not legacy:
                    row, raw = await self.sources.original(who, UUID(parts[1]))
                    return Response(raw, media_type="application/octet-stream", headers={
                        **headers, "Content-Disposition": 'attachment; filename="feed-original.bin"',
                        "X-Content-SHA256": row["raw_sha256"], "X-Content-Type-Options": "nosniff",
                    })
                elif len(parts) == 2 and parts[0] == "avatar" and not legacy:
                    if not re.fullmatch("[a-f0-9]{64}", parts[1]):
                        raise HTTPException(404, "本人形象文件不存在")
                    async with self.db.connection() as conn, conn.transaction():
                        await authorize(conn, who)
                        raw = await ResourceMedia(self.db.settings).read(conn, who.id, parts[1])
                    mime = await asyncio.to_thread(avatar_mime, raw)
                    return Response(raw, media_type=mime, headers={**headers, "X-Content-Type-Options": "nosniff"})
                else:
                    raise HTTPException(404, "动态接口不存在")
            elif request.method == "POST" and parts == ["profile", "avatar"]:
                result, rid, tracked = await self.upload(request, who, legacy=legacy)
                if legacy:
                    result = result["result"]
            else:
                raw = await self.json_body(request, legacy)
                who = await feed_identity(request, self.db, version=version, write=True)
                verb = request.method
                control = verb == "POST" and len(parts) == 3 and parts[0] == "jobs" and parts[2] == "cancel" and not legacy
                rid, tracked = (None, True) if control else operation_id(request, raw, legacy=legacy)
                if verb == "POST" and parts == ["subscriptions", "test"]:
                    if not await self.app.state.rate_limit(self.db, digest("feed-source-test:" + who.id), 6, window_seconds=60):
                        raise HTTPException(429, "订阅测试过于频繁")
                    target_id = raw.get("targetId")
                    source_name=None
                    if target_id is None and legacy:
                        source=subscriptions([raw])[0]
                        source_name=source['name']
                        matches = [row for row in self.sources.targets(who).get("targets", []) if row.get("provider")=='rss-atom' and row.get("url") == source['url']]
                        if len(matches) != 1:
                            raise HTTPException(409, "此订阅未对应唯一已安装许可来源")
                        target_id = matches[0]["id"]
                    elif set(raw) != {"targetId"}:
                        raise HTTPException(400, "请选择已安装来源")
                    result = await self.sources.test_source(who, {"requestId": rid, "targetId": target_id},source_name=source_name)
                    if legacy:
                        result=await self.wait_job(who,result)
                        if result['state']=='succeeded':
                            observed=next((r for r in result['sources']if r.get('state')=='succeeded'and 'count'in r),None)
                            if observed:
                                observed_url=None
                                try:
                                    admission,_raw=await self.sources.request_original(who,UUID(observed['pageId']))
                                    target=self.sources.target(who.id,admission['target_id'])
                                    from .feed_sources import fingerprint
                                    if fingerprint(target)==admission['target_fingerprint']:observed_url=target['url']
                                except HTTPException as exc:
                                    if exc.status_code!=409:raise
                                result={'title':observed['title'],'count':observed['count'],'url':observed_url,'sourceUrlKnown':observed_url is not None,'requestId':rid,'sourcePageId':observed['pageId']}

                elif verb == "POST" and parts == ["refresh"]:
                    if set(raw) - {"groupId", "groupRevision", "targetIds", "modelTargetId", "scheduled"}:
                        raise HTTPException(400, "刷新字段无效")
                    selected_group = raw.get("groupId", group)
                    command = {**raw, "requestId": rid, "groupId": selected_group}
                    if "groupRevision" not in command:
                        command["groupRevision"] = await self.group_revision(who, selected_group)
                    result = await self.sources.refresh(who, command,legacy=legacy)
                elif verb == "POST" and len(parts) == 3 and parts[0] == "jobs" and parts[2] == "cancel" and not legacy:
                    if raw:
                        raise HTTPException(400, "取消任务不接受额外字段")
                    result = await self.sources.cancel(who, UUID(parts[1]))
                    result = {**result, "cancellationRequestIsNewCollection": False}
                    rid = None  # Query the original job, not an invented cancellation receipt.
                else:
                    core_action, post_id, selected_group = None, None, group
                    if verb == "POST" and parts == ["groups"]:
                        core_action = "group.create"
                    elif verb == "PUT" and len(parts) == 2 and parts[0] == "groups":
                        core_action, selected_group = "group.rename", parts[1]
                    elif verb == "PUT" and parts == ["preferences"]:
                        core_action = "preferences"
                    elif verb == "PUT" and parts == ["profile"]:
                        core_action = "profile"
                    elif verb == "PUT" and len(parts) == 2 and parts[0] == "posts":
                        core_action, post_id = "post.mark", parts[1]
                    elif verb == "POST" and len(parts) == 3 and parts[0] == "posts" and parts[2] == "discussion":
                        core_action, post_id = "discussion", parts[1]
                        if legacy and "modelTargetId" not in raw:
                            choices = [row for row in self.models.available(who.id) if row["purpose"] == "feed.discussion"]
                            if choices:raw['modelTargetId']=choices[0]['id']
                            else:raise HTTPException(503 if not choices else 409,'帖子讨论须有唯一已安装文本模型或明确选择')
                    if core_action is None:
                        raise HTTPException(404, "动态接口不存在")
                    result = await self.core.mutate(who, rid, core_action, raw, group_id=selected_group, post_id=post_id)
                    outcome = result["result"]
                    if core_action == "discussion":
                        result = {**result, "replyState": "not_requested"}
                        if outcome.get("replyModelTargetId"):
                            try:
                                result["replyJob"] = await self.sources.discuss(who, {
                                    "requestId": str(uuid5(UUID(rid), "discussion")), "parentRequestId": rid,
                                    "postId": outcome["postId"], "messageId": outcome["messageId"],
                                    "revision": outcome["revision"],
                                    "targetId": outcome["replyModelTargetId"],
                                },legacy=legacy)
                                result["replyState"] = result["replyJob"]["state"]
                            except HTTPException as exc:
                                result.update(replyState="unavailable", replyError=str(exc.detail))
                    if (core_action == "preferences" and outcome.get("enabled") is True) or (core_action == "group.create" and outcome.get("mode")=="people"):
                        if core_action=="group.create":selected_group=outcome["id"]
                        try:
                            result = {**result, "automation": await self.sources.refresh(who, {
                                "requestId": str(uuid5(UUID(rid), "scheduled-refresh")),
                                "groupId": selected_group, "groupRevision": outcome["revision"], "scheduled": True,
                            })}
                        except HTTPException as exc:
                            result = {**result, "automation": {"state": "unavailable", "reason": str(exc.detail)}}
                    if legacy:
                        if core_action=='discussion'and result.get('replyJob'):
                            result['replyJob']=await self.wait_job(who,result['replyJob'])
                            result['replyState']=result['replyJob']['state']
                            if result['replyState']=='succeeded':outcome={**outcome,**await self.core.discussion(who,post_id), 'assistantReplyGenerated':True}
                        result = {**outcome, **{key: result[key] for key in ("replyJob", "replyState", "replyError", "automation") if key in result}}
            if rid:
                headers["X-Alcor-Request-Id"] = rid
                if not tracked:
                    headers["X-Alcor-Request-Id-Mode"] = "generated_legacy"
            pending=legacy and ((parts==['subscriptions','test']and isinstance(result,dict)and result.get('state')in {'queued','running','unknown'})or (len(parts)==3 and parts[0]=='posts'and parts[2]=='discussion'and request.method=='POST'and result.get('replyState')not in {None,'succeeded'}))
            if pending:
                return JSONResponse({'code':20201,'message':'原任务尚未完成，请按原UUID读取结果，不要重复提交','data':{**result,'pending':True,'requestId':rid}},status_code=202,headers=headers)
            return JSONResponse({"code": 0, "message": "ok", "data": result} if legacy else result, headers=headers)
        except (HTTPException, StarletteHTTPException) as exc:
            headers.update(getattr(exc, "headers", None) or {})
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            code = getattr(exc, "business_code", exc.status_code * 100 + 1)
            return JSONResponse(
                {"code": code, "message": str(exc.detail)} if legacy else {"error": {"code": code, "message": str(exc.detail)}},
                status_code=exc.status_code, headers=headers,
            )
        except (ValueError, TypeError, UnicodeError):
            return JSONResponse(
                {"code": 40001, "message": "动态标识或内容无效"} if legacy else {"error": {"code": 40001, "message": "动态标识或内容无效"}},
                status_code=400, headers=headers,
            )


def mount_feed(app, db):
    transport = FeedTransport(app, db)
    app.state.feed_transport = transport
    app.state.feed_sources = transport.sources
    leaves = {
        "": ["GET"],"subscriptions/test":["POST"],"refresh":["POST"], "profile": ["GET", "PUT"], "profile/avatar": ["POST"],
        "groups": ["GET", "POST"], "groups/{group_id}": ["PUT"], "preferences": ["GET", "PUT"],
        "posts/{post_id}": ["GET", "PUT"], "posts/{post_id}/discussion": ["GET", "POST"],
        "jobs": ["GET"], "jobs/{job_id}": ["GET"], "jobs/{job_id}/cancel": ["POST"],
        "operations/{request_id}": ["GET"], "targets": ["GET"],
        "originals/{page_id}": ["GET"],"originals/{page_id}/request":["GET"], "avatar/{sha}": ["GET"],
    }
    def handler(path):
        async def route(request: Request, **path_values):
            return await transport.execute(request, request.url.path.removeprefix("/api/feed").lstrip("/"))
        route.__signature__ = Signature([
            Parameter("request", Parameter.POSITIONAL_OR_KEYWORD, annotation=Request),
            *[Parameter(name, Parameter.POSITIONAL_OR_KEYWORD, annotation=str)
              for name in re.findall(r"{(\w+)}", path)],
        ])
        return route
    for index, (path, methods) in enumerate(leaves.items()):
        for method in methods:
            app.add_api_route("/api/feed" + ("/" + path if path else ""), handler(path), methods=[method],
                             operation_id="feed_" + str(index) + "_" + method.lower(), tags=["feed"])
    return transport
