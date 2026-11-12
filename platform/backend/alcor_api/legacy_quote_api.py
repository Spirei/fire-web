"""Old POST reads over PG only. Public licensed-source approval remains explicit."""

import asyncio
import gzip
import json
import re
from uuid import UUID, uuid4

from fastapi import HTTPException, Request, Response

from .fx_provider_parser import unique
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, native_identity, web_identity
from .market_quote_reads import BatchQuotes, items_from
from .market_sessions import requested_session
from .market_subscription_writes import Subscriptions, subscription_items
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import COOKIE, digest, identity


def gzip_allowed(header):
    for value in header.lower().split(","):
        name,*params=value.strip().split(";")
        if name!="gzip":continue
        quality=next((item.strip()[2:] for item in params if item.strip().startswith("q=")),None)
        try:
            if quality is None or 0<float(quality)<=1:return True
        except ValueError:continue
    return False


def mount_legacy_quote_reads(app,settings,authority):
    service=BatchQuotes(authority)
    app.state.batch_quote_reads=service

    async def member(request,version,canonical):
        header=request.headers.get("authorization")
        if version==2 or header is not None and header.startswith("Bearer fat_"):
            who,grant=await native_identity(request,authority.db,"portfolio.read")
            if grant["client_id"]!=CLIENT:raise HTTPException(401,"连接已失效")
            return who
        if header is not None and version!=1:raise HTTPException(401,"行情读取凭据无效")
        if canonical:return await identity(request)
        if version==1 or request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE):
            return (await web_identity(request,authority.db,allow_v1_bearer=version==1))[0]
        if request.cookies.get(COOKIE):return await identity(request)
        raise HTTPException(401,"本人行情需要登录和当前来源许可；公开来源尚未授权")

    async def execute(request,version=None,canonical=False):
        headers={"Cache-Control":"no-store, private","Vary":"Authorization, Cookie, Accept-Encoding"}
        if version:headers["X-Alcor-API-Version"]=str(version)
        try:
            assert_native_origin(request,settings)
            if request.query_params:raise HTTPException(400,"不支持查询参数")
            caller=request.client.host if request.client else "unknown"
            if not await app.state.read_rate_limit(authority.db,digest("quotes:"+caller),120,window_seconds=60) or not await app.state.read_rate_limit(authority.db,"quotes-global",600,window_seconds=60):raise HTTPException(429,"请求过于频繁，请稍后再试",headers={"Retry-After":"60"})
            who=None
            auth_cookie=any(name in request.cookies for name in (COOKIE,WEB_COOKIE,OLD_COOKIE)) or any(
                re.search(r'(?:^|;)[ \t]*'+re.escape(name)+r'[ \t]*(?:=|;|$)',request.headers.get('cookie',''))
                for name in (COOKIE,WEB_COOKIE,OLD_COOKIE))
            if canonical or version==2 or "authorization" in request.headers or auth_cookie:who=await member(request,version,canonical)
            def reject_constant(_):raise ValueError()
            try:body=json.loads(await bounded_body(request,65536),object_pairs_hook=unique,parse_constant=reject_constant)
            except (ValueError,UnicodeError,RecursionError) as invalid:
                if canonical or str(invalid)=="duplicate_key":raise HTTPException(400,"行情请求JSON无效") from None
                body=None
            items=items_from(body)
            selected_session=body.get("session") if isinstance(body,dict) else None
            if selected_session not in (None,"REGULAR","PRE","AFTER","OVERNIGHT"):raise HTTPException(400,"最新报价时段无效")
            if selected_session is None and not canonical:selected_session=requested_session()
            tracking={"tracked":False,"automaticCollection":False,"reason":"canonical_explicit_demand_only" if canonical else "empty_request"}
            if not items:
                result={"quotes":{},"quoteStates":{}}
            else:
                public = not canonical and version != 2 and "authorization" not in request.headers and not auth_cookie
                if public:
                    reader = getattr(app.state, "public_market_quotes", None)
                    if reader is None:
                        raise HTTPException(503, "公共报价再分发许可未配置或已失效")
                    result = await reader.read(items, include_market_cap=not isinstance(body,dict) or body.get("includeMarketCap") is not False)
                    tracking = {"tracked":False,"automaticCollection":False,"reason":"public_read_only"}
                    headers["X-Alcor-Quote-Tracked"] = "false"
                else:
                    who=who or await member(request,version,canonical)
                    register_demand = not canonical
                    if register_demand:
                        tracking={"tracked":False,"reason":"write_scope_or_explicit_source_required","automaticCollection":False}
                        operation_started=False
                        try:
                            writer=who
                            if getattr(who,"native_client",False):
                                writer,_=await native_identity(request,authority.db,"portfolio.write")
                            identifier=request.headers.get("x-alcor-request-id")
                            generated=identifier is None
                            identifier=uuid4() if generated else UUID(identifier)
                            headers["X-Alcor-Request-Id"]=str(identifier)
                            selected=request.headers.get("x-alcor-market-source")
                            selected=UUID(selected) if selected else None
                            normalized=subscription_items({"items":[{"market":item["market"],"code":item["code"]} for item in items]})
                            operation_started=True
                            tracked,_=await Subscriptions(authority).mutate(writer,identifier,normalized,selected=selected,observe=True,legacy_generated=generated,source_preference=getattr(settings,"_legacy_quote_source",None),session=selected_session)
                            tracking={"tracked":True,"requestId":str(identifier),"receiptId":str(identifier),"legacyClientIdempotency":tracked.get("legacyClientIdempotency",not generated),
                                      "collection":tracked['collection'],"automaticCollection":False,"scope":"explicit_post_quote_request"}
                            headers["X-Alcor-Request-Id"]=str(identifier)
                            headers["X-Alcor-Legacy-Client-Idempotency"]="false" if generated else "true"
                            headers["X-Alcor-Operation-Receipt"]="/api/market/operations/"+str(identifier)
                        except (HTTPException,ValueError) as missing:
                            tracking["reason"]="demand_not_registered"
                            tracking["status"]=missing.status_code if isinstance(missing,HTTPException) else 400
                        except Exception:  # noqa: BLE001 -- Optional bookkeeping must not invent a confirmed failure or replay after an uncertain commit.
                            if operation_started:
                                headers["X-Alcor-Operation-Receipt"]="/api/market/operations/"+str(identifier)
                                headers["X-Alcor-Legacy-Client-Idempotency"]="false" if generated else "true"
                                tracking={"tracked":None,"state":"unknown","automaticReplay":False,
                                          "requestId":str(identifier),"receiptId":str(identifier)}
                            else:
                                tracking={"tracked":False,"reason":"demand_precondition_unavailable","automaticCollection":False}
                        headers["X-Alcor-Quote-Tracked"]="unknown" if tracking["tracked"] is None else "true" if tracking["tracked"] else "false"
                    result=await service.read(who,items,request.headers.get("x-alcor-market-source"),session=selected_session if canonical else None,preferred_session=None if canonical else selected_session,include_market_cap=not isinstance(body,dict) or body.get("includeMarketCap") is not False,strict_sources=not canonical,source_preference=None if canonical else getattr(settings,"_legacy_quote_source",None))
            data=result if canonical else {"quotes":result["quotes"]}
            if not canonical and items and request.headers.get("x-alcor-register-demand") == "true":
                data["tracking"]=tracking
            payload={"code":0,"message":"ok","data":data} if version else data
            states=[value["state"] for value in result["quoteStates"].values()]
            headers["X-Alcor-Quote-State"]="empty" if not states else "observed" if all(value=="observed" for value in states) else "partial"
            raw=json.dumps(payload,separators=(",",":"),ensure_ascii=False,allow_nan=False).encode()
            if version and len(raw)>=1024 and gzip_allowed(request.headers.get("accept-encoding","")):
                packed=await asyncio.to_thread(gzip.compress,raw,mtime=0)
                if len(packed)<len(raw):raw=packed;headers["Content-Encoding"]="gzip"
            return Response(raw,media_type="application/json",headers=headers)
        except HTTPException as exc:
            if exc.headers:headers.update(exc.headers)
            if exc.status_code in (401,403):headers["X-Alcor-Retire-Context"]="true"
            if version:payload={"code":50001 if exc.status_code>=500 else exc.status_code*100+1,"message":str(exc.detail)}
            elif canonical:payload={"error":{"code":exc.status_code,"message":str(exc.detail)}}
            else:payload={"error":str(exc.detail)}
            return Response(json.dumps(payload,ensure_ascii=False),media_type="application/json",status_code=exc.status_code,headers=headers)

    @app.post("/api/quotes")
    async def web_quotes(request:Request):return await execute(request)

    @app.post("/api/v1/quotes")
    async def native_v1_quotes(request:Request):return await execute(request,1)

    @app.post("/api/v2/quotes")
    async def native_v2_quotes(request:Request):return await execute(request,2)

    @app.post("/api/market/quotes/read")
    async def canonical_quotes(request:Request):return await execute(request,canonical=True)
