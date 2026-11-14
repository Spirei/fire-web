"""Non-financial group list/create/reorder compatibility; file actions remain separate."""

import json
import math
from functools import wraps
from uuid import UUID, uuid4

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse

from .legacy_identity import LegacyError, body, envelope
from .legacy_portfolio import portfolio_member
from .profile_http import bounded_body
from .security import digest
from .watchlists import WatchGroups


def legacy_group(row):
    return {key: row[key] for key in ("id", "name", "icon", "sort", "visible", "kind", "market")}


def assignment_group_string(value):
    # The original assignment route uses String(value ?? ""). Arrays use join;
    # in particular null and [] clear membership, rather than become invalid IDs.
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ",".join(assignment_group_string(item) for item in value)
    if isinstance(value, dict):
        return "[object Object]"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def mount_legacy_watchlists(app, settings, db, rate_limit, rate_limits=None):
    service = WatchGroups(db)

    async def member(request, write=False):
        who = await portfolio_member(request, settings, db, write=write)
        address = request.client.host if request.client else "unknown"
        checks = (
            (digest("watch-groups:" + address), 60 if write else 120),
            ("watch-groups-global", 300),
        )
        if rate_limits is not None:
            allowed = await rate_limits(db, checks, window_seconds=60)
        else:
            allowed = all(
                [await rate_limit(db, key, maximum, window_seconds=60) for key, maximum in checks]
            )
        if not allowed:
            raise LegacyError(429, 42901, "请求过于频繁，请稍后再试")
        return who

    def guarded(function):
        @wraps(function)
        async def execute(*args, **kwargs):
            try:
                response=kwargs.get('response')
                if response is not None:response.headers.update({'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'})
                return await function(*args, **kwargs)
            except HTTPException as exc:
                headers={"Cache-Control":"no-store, private","Vary":"Cookie, Authorization",**(exc.headers or {})}
                if exc.status_code in (401,403):headers['X-Alcor-Retire-Context']='true'
                version=kwargs.get('version')
                if version not in (1,2) and kwargs.get('request') is not None:
                    import re
                    matched=re.match(r'/api/v([12])/',kwargs['request'].url.path)
                    version=int(matched[1]) if matched else None
                if version in (1,2):headers['X-Alcor-API-Version']=str(version)
                return JSONResponse({"code":getattr(exc,"business_code",exc.status_code*100+1),"message":str(exc.detail)},status_code=exc.status_code,headers=headers)
        return execute

    async def group_body(request):
        try:
            def constant(_):raise ValueError()
            value=json.loads(await bounded_body(request,65536),parse_constant=constant)
            return value if isinstance(value,dict) else {}
        except (ValueError,UnicodeError,RecursionError):return {}

    def request_id(request,response):
        raw=request.headers.get("x-alcor-request-id")
        try:identifier=UUID(raw) if raw is not None else uuid4()
        except (ValueError,TypeError,AttributeError):raise LegacyError(400,40001,"原请求编号无效") from None
        response.headers["X-Alcor-Request-Id"]=str(identifier)
        if raw is None:response.headers["X-Alcor-Request-Id-Mode"]="generated_legacy"
        return identifier

    def expected_revision(request):
        value=request.headers.get('x-alcor-expected-revision')
        if value is None:return None
        if not value.isascii() or not value.isdecimal() or int(value)>9007199254740991:
            raise LegacyError(400,40001,'分组版本无效')
        return int(value)

    @app.get("/api/v{version}/watch-groups", tags=["legacy-native-watchlists"])
    @guarded
    async def listing(version: int, request: Request, response: Response):
        who = await member(request)
        result = await service.list(who.id, authorization=who)
        if not result["initialized"]:
            raise LegacyError(409,40901,"分组尚未初始化；请显式初始化或导入已核对的旧分组")
        return envelope({"groups": [legacy_group(r) for r in result["groups"]]}, request, response)

    @app.post("/api/v{version}/watch-groups", tags=["legacy-native-watchlists"])
    @guarded
    async def create(version: int, request: Request, response: Response):
        who = await member(request, True)
        raw = await group_body(request)
        name = assignment_group_string(raw.get("name", ""))
        if not name.strip():
            raise LegacyError(400, 40001, "缺少分组名称")
        try:
            result = await service.mutate(who.id, "create", {"name": name}, request_id(request,response), expected_revision=expected_revision(request),authorization=who,legacy_ids=True)
        except HTTPException as exc:
            if exc.status_code in {400, 409}:
                raise LegacyError(409, 40901, str(exc.detail)) from None
            raise
        return envelope({"group": legacy_group(result["group"])}, request, response)

    @app.put("/api/v{version}/watch-groups/{group_id}", tags=["legacy-native-watchlists"])
    @guarded
    async def update(version: int, group_id: str, request: Request, response: Response):
        who=await member(request,True)
        raw=await group_body(request)
        data={"id":group_id}
        if "icon" in raw:
            icon = "null" if raw["icon"] is None else assignment_group_string(raw["icon"])
            icon = icon.strip()
            if len(icon)>2048 or icon and not icon.startswith("/uploads/") and not icon.lower().startswith("https://"):
                raise LegacyError(400,40001,"分组图标地址不合法")
            data["icon"] = icon
        if "name" in raw:data["name"]="null" if raw["name"] is None else assignment_group_string(raw["name"])
        if "visible" in raw:
            value=raw["visible"]
            if isinstance(value,(list,dict)):value=assignment_group_string(value)
            try:
                if value is None or isinstance(value,str) and not value.strip():value=0
                elif isinstance(value,str) and value.strip().lower().startswith(("0x","0o","0b")):value=int(value.strip(),0)
                else:value=float(value)
                if not math.isfinite(value) or value not in (-1,0,1):raise ValueError()
            except (ValueError,TypeError,OverflowError):raise LegacyError(400,40001,"visible 必须为 -1 / 0 / 1") from None
            data["visible"]=int(value)
        try:
            result=await service.mutate(who.id,"update",data,request_id(request,response),expected_revision=expected_revision(request),authorization=who,legacy_ids=True)
        except HTTPException as exc:
            if exc.status_code in (400,404,409):raise LegacyError(409,40901,"分组不存在；旧编号需明确映射" if exc.status_code==404 else str(exc.detail)) from None
            raise
        return envelope({"group":legacy_group(result["group"])},request,response)

    @app.delete("/api/v{version}/watch-groups/{group_id}", tags=["legacy-native-watchlists"])
    @guarded
    async def delete(version: int, group_id: str, request: Request, response: Response):
        who=await member(request,True)
        try:result=await service.mutate(who.id,"delete",{"id":group_id},request_id(request,response),expected_revision=expected_revision(request),authorization=who,legacy_ids=True)
        except HTTPException as exc:
            if exc.status_code==400:raise LegacyError(400,40001,str(exc.detail)) from None
            raise
        return envelope({"deleted":result["deleted"]},request,response)

    @app.post("/api/v{version}/watch-groups/reorder", tags=["legacy-native-watchlists"])
    @guarded
    async def reorder(version: int, request: Request, response: Response):
        who = await member(request, True)
        raw = await body(request, ("order",))
        supplied = raw.get("order", [])
        order = list(dict.fromkeys(i for i in supplied if isinstance(i, str) and 1 <= len(i) <= 100)) if isinstance(supplied, list) else []
        if not order or len(order) > 100:
            raise LegacyError(400, 40001, "缺少分组顺序或分组数量超出限制")
        result = await service.mutate(who.id, "legacy-reorder", {"order": order}, request_id(request,response), expected_revision=expected_revision(request),authorization=who,legacy_ids=True)
        return envelope({"updated": result["updated"]}, request, response)

    @app.post("/api/v{version}/records/group-assign", tags=["legacy-native-watchlists"])
    @guarded
    async def assign(version: int, request: Request, response: Response):
        who = await member(request, True)
        raw = await body(request, ("ids", "groupId"), 262144)
        supplied = raw.get("ids", [])
        ids = list(dict.fromkeys(i for i in supplied if isinstance(i, str) and 1 <= len(i.encode("utf-16-le", errors="surrogatepass")) // 2 <= 100)) if isinstance(supplied, list) else []
        group_id = assignment_group_string(raw.get("groupId", ""))
        if not ids or len(ids) > 2000 or not isinstance(group_id, str) or len(group_id) > 100:
            raise LegacyError(400, 40001, "缺少记录 id 或分组参数无效")
        group_id = group_id.strip()
        try:
            result = await service.mutate(who.id, "legacy-assign", {"ids": ids, "groupId": group_id}, request_id(request,response), expected_revision=expected_revision(request),authorization=who,legacy_ids=True)
        except HTTPException as exc:
            if exc.status_code in {400, 404, 409}:
                raise LegacyError(400, 40001, str(exc.detail)) from None
            raise
        return envelope({"updated": result["updated"]}, request, response)

    @app.post("/api/v{version}/records/group-reorder", tags=["legacy-native-watchlists"])
    @guarded
    async def reorder_records(version: int, request: Request, response: Response):
        who = await member(request, True)
        raw = await body(request, ("ids", "groupId"), 262144)
        supplied, group_id = raw.get("ids", []), raw.get("groupId", "")
        ids = [i for i in supplied if isinstance(i, str) and i] if isinstance(supplied, list) else []
        if not isinstance(group_id, str) or not group_id.strip() or len(ids) > 2000:
            raise LegacyError(400, 40001, "排序参数无效")
        try:
            result = await service.mutate(who.id, "legacy-reorder-records", {"ids": ids, "groupId": group_id.strip()}, request_id(request,response), expected_revision=expected_revision(request),authorization=who,legacy_ids=True)
        except HTTPException as exc:
            if exc.status_code in {400, 404, 409}:
                raise LegacyError(400, 40001, str(exc.detail)) from None
            raise
        return envelope({"updated": result["updated"]}, request, response)

    @app.get('/api/v1/watch-groups/operations/{request_id}')
    @app.get('/api/v2/watch-groups/operations/{request_id}')
    @guarded
    async def operation(request_id:str,request:Request,response:Response):
        who=await member(request)
        return envelope(await service.receipt(who.id,request_id,authorization=who),request,response)
