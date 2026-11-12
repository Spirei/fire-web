"""Current Fire UI adapters; all writes share native PG domain transactions."""

import asyncio
import io
import re
import unicodedata
import warnings
from datetime import datetime, time, timedelta
from typing import Annotated
from uuid import UUID, uuid4, uuid5

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from psycopg.types.json import Jsonb

from .asset_catalog_management import fingerprint, page_number
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, body, public_profile, web_identity
from .personal_profiles import identifier
from .request_activity import ZONE, snapshot
from .security import Identity, digest, lock_mutation_identity

router = APIRouter(tags=["fire-current-web"])
PRIVATE = {"Cache-Control": "private, no-store"}
KINDS = {"market", "stock", "crypto", "metal", "flag", "broker", "card", "icon"}
MARKETS = ("US", "HK", "CN", "JP", "KR", "SG", "UK", "DE", "FR", "AU", "CA", "IN", "TW", "BR")


async def member(request: Request):
    if request.headers.get("authorization") is not None:
        raise HTTPException(403, "请使用 Fire 网页会话")
    a, b = request.cookies.get(WEB_COOKIE), request.cookies.get(OLD_COOKIE)
    if a and b and a != b:
        raise HTTPException(403, "网页登录身份不一致，请重新登录")
    who, _, _ = await web_identity(request, request.app.state.db)
    return who


Member = Annotated[Identity, Depends(member)]


def ticker_items(config):
    from .market_indices import index_identity
    presentation=config.get('legacyPresentation',{})
    configured=presentation.get('items') or config.get('items',[])
    items=[]
    for item in configured[:20]:
        identified=index_identity(item.get('market'),item.get('secid',item.get('legacySecid')))
        if identified:items.append({'id':item['key'],'market':identified[0],'code':identified[1]})
    return configured,items


async def index_demand(request,who,items):
    from .market_subscription_writes import Subscriptions,subscription_items
    raw=await body(request,('requestId',))
    if set(raw)!={'requestId'}:raise HTTPException(400,'指数需求字段无效')
    try:rid=UUID(str(raw['requestId']))
    except (ValueError,TypeError):raise HTTPException(400,'请求编号无效') from None
    await budget(request,who,'workspace-ticker-demand',30)
    if not items:return JSONResponse({'requestId':str(rid),'state':'empty'},headers=PRIVATE)
    normalized=subscription_items({'items':[{'market':i['market'],'code':i['code']} for i in items]})
    result,_=await Subscriptions(request.app.state.market_authority).mutate(who,rid,normalized,observe=True,source_preference='auto',instrument='index')
    return JSONResponse(result,headers=PRIVATE)


@router.post('/api/fire/ticker/demand')
async def ticker_demand(request: Request, who: Member):
    _,items=ticker_items(getattr(request.app.state.db.settings,'public_ticker',{}))
    return await index_demand(request,who,items)


@router.post('/api/fire/indices/demand')
async def indices_demand(request: Request, who: Member):
    from .market_index_reads import items
    return await index_demand(request,who,items())


@router.get("/api/fire/ticker")
async def workspace_ticker(request: Request, who: Member):
    """The private workspace is not an anonymous public redistribution client."""
    from .market_quote_reads import BatchQuotes
    await budget(request, who, "workspace-ticker", 60)
    db = request.app.state.db
    config = getattr(db.settings, "public_ticker", {})
    presentation = config.get("legacyPresentation", {})
    configured = presentation.get("items") or config.get("items", [])
    configured,items=ticker_items(config)
    result = await BatchQuotes(request.app.state.market_authority).read(
        who, items, include_market_cap=False, strict_sources=False, instrument="index",
        source_preference="auto",
    ) if items else {"quotes": {}}
    output = []
    for item in configured[:20]:
        quote = result["quotes"].get(item["key"], {})
        output.append({"key": item["key"], "label": item.get("label", item["key"]), "market": item.get("market", ""), "secid": item.get("secid", item.get("legacySecid")),
                       "price": quote.get("price"), "change": quote.get("change"), "changePct": quote.get("changePct"),
                       "points": [], "observedAt": quote.get("time"), "source": quote.get("source"),
                       "session": quote.get("session"), "displayStale": quote.get("displayStale"), "cached": quote.get("cached"),
                       "sourceRevision": result.get("quoteStates", {}).get(item["key"], {}).get("sourceRevision")})
    return JSONResponse({"items": output, "interval": presentation.get("interval", 5), "pollSec": 60,
                         "collectionOnRead": False}, headers=PRIVATE)


def parameters(request, allowed=()):
    if set(request.query_params) - set(allowed) or any(len(request.query_params.getlist(k)) != 1 for k in request.query_params):
        raise HTTPException(400, "查询参数无效")


def revision(value):
    if type(value) is not int or not 0 <= value < 9007199254740991:
        raise HTTPException(400, "版本无效")
    return value


async def budget(request, who, purpose, amount=120):
    if not await request.app.state.rate_limit(request.app.state.db, digest(purpose + ":" + who.id), amount, window_seconds=60):
        raise HTTPException(429, "操作过于频繁，请稍后再试")


async def profile_result(request, who, profile, request_id=None):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=False)
        user = await public_profile(conn, who.id)
    return JSONResponse({"user": user, "profile": profile, **({"requestId": request_id} if request_id else {})}, headers=PRIVATE)


@router.get("/api/auth/personal-home")
async def personal_home(request: Request, who: Member):
    parameters(request, ("kind", "v"))
    service = request.app.state.personal_profiles
    if request.query_params.get("kind") == "background":
        raw, content_type = await service.background(who, request.query_params.get("v"))
        return Response(raw, media_type=content_type, headers={**PRIVATE, "X-Content-Type-Options": "nosniff"})
    if request.query_params:
        raise HTTPException(400, "查询参数无效")
    return await profile_result(request, who, await service.read(who, "/api/auth/personal-home?kind=background"))


@router.patch("/api/auth/personal-home")
async def update_personal_home(request: Request, who: Member):
    parameters(request)
    await budget(request, who, "fire-profile", 30)
    raw = await body(request, ("requestId", "revision", "nickname", "bio", "gender"))
    if set(raw) != {"requestId", "revision", "nickname", "bio", "gender"}:
        raise HTTPException(400, "资料字段无效")
    result, error = await request.app.state.personal_profiles.mutate(who, {
        "requestId": raw["requestId"], "revision": raw["revision"],
        "changes": {"bio": raw["bio"], "gender": raw["gender"]},
    }, "/api/auth/personal-home?kind=background", request.state.request_id, nickname=raw["nickname"])
    if error:
        raise error
    return await profile_result(request, who, result["data"], raw["requestId"])


def normalize_web_background(raw):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as original:
                if original.format not in {"JPEG", "PNG", "WEBP"} or original.width * original.height > 40_000_000:
                    raise ValueError()
                if original.format == "JPEG":
                    original.draft("RGB", (2048, 2048))
                original.load()
                image = ImageOps.exif_transpose(original).convert("RGB")
                image.thumbnail((2048, 2048))
                output = io.BytesIO()
                image.save(output, "JPEG", quality=88)
                return output.getvalue()
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(400, "图片无法读取，请选择 JPEG、PNG 或 WebP 图片") from None


@router.post("/api/auth/personal-home")
async def upload_personal_background(request: Request, who: Member):
    parameters(request)
    await budget(request, who, "fire-profile", 30)
    # Bound the complete request before multipart parsing, including chunked input.
    count, chunks = 0, []
    async for chunk in request.stream():
        count += len(chunk)
        if count > 8 * 1024**2 + 65536:
            raise HTTPException(413, "图片不能超过8 MB")
        chunks.append(chunk)
    request._body = b"".join(chunks if count else [])
    async with request.form(max_files=1, max_fields=2, max_part_size=8 * 1024**2) as form:
        if set(form) != {"file", "requestId", "revision"} or any(len(form.getlist(k)) != 1 for k in form):
            raise HTTPException(400, "上传字段无效")
        upload, rid, version = form["file"], form["requestId"], form["revision"]
        if not hasattr(upload, "read") or not isinstance(version, str) or not re.fullmatch(r"0|[1-9][0-9]{0,15}", version):
            raise HTTPException(400, "上传字段无效")
        raw = await upload.read(8 * 1024**2 + 1)
        if not raw or len(raw) > 8 * 1024**2:
            raise HTTPException(413, "图片不能超过8 MB")
        clean = await asyncio.to_thread(normalize_web_background, raw)
    result, error = await request.app.state.personal_profiles.mutate(who, {"requestId": rid, "revision": int(version)}, "/api/auth/personal-home?kind=background", request.state.request_id, background=clean)
    if error:
        raise error
    return await profile_result(request, who, result["data"], rid)


@router.get("/api/auth/personal-activity")
async def personal_activity(request: Request, who: Member):
    parameters(request)
    db = request.app.state.db
    observed = await snapshot(db, who.id)
    today = observed["end"]
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=False)
        rows = await (await conn.execute("SELECT day,requests FROM account_request_activity WHERE user_id=%s AND day<=%s AND requests>0 ORDER BY day", (who.id, today))).fetchall()
    longest = streak = 0
    previous = None
    for row in rows:
        streak = streak + 1 if previous is not None and row["day"] == previous + timedelta(days=1) else 1
        previous = row["day"]
        longest = max(longest, streak)
    current = streak if previous in (today, today - timedelta(days=1)) else 0
    return JSONResponse({"total": sum(r["requests"] for r in rows), "activeDays": len(rows), "longest": longest, "current": current, "since": int(datetime.combine(observed["observed_since"], time(), ZONE).timestamp() * 1000), "today": today.isoformat(), "days": {r["day"].isoformat(): r["requests"] for r in rows}, "incomplete": observed["incomplete"], "observedOnly": True}, headers=PRIVATE)


def search_mutation(raw, method):
    action = raw.get("action")
    fields = {"record": {"action", "revision", "query"}, "remove": {"action", "revision", "id"}, "clear": {"action", "revision"}}
    if not isinstance(action, str) or action not in fields or set(raw) != fields[action] or (method == "POST") != (action == "record"):
        raise HTTPException(400, "搜索历史操作无效")
    revision(raw.get("revision"))
    if action == "record":
        if not isinstance(raw["query"], str):
            raise HTTPException(400, "搜索词无效")
        query = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", raw["query"]).strip())
        if not 1 <= len(query) <= 80 or re.search(r"[\x00-\x1f\x7f]", query):
            raise HTTPException(400, "搜索词无效")
        try:
            query.encode("utf-8")
        except UnicodeError:
            raise HTTPException(400, "搜索词包含无效字符") from None
        raw = {**raw, "query": query}
    elif action == "remove":
        identifier(raw["id"].lower() if isinstance(raw["id"], str) else raw["id"])
    return raw


async def history(request, who, mutation=None):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=False)
        await conn.execute("INSERT INTO user_search_history_state(user_id) VALUES(%s) ON CONFLICT DO NOTHING", (who.id,))
        current = (await (await conn.execute("SELECT revision FROM user_search_history_state WHERE user_id=%s FOR UPDATE", (who.id,))).fetchone())["revision"]
        conflict = mutation is not None and current != mutation["revision"]
        if mutation is not None and not conflict:
            if current >= 9007199254740990:
                raise HTTPException(409, "搜索历史版本已达上限")
            if mutation["action"] == "record":
                query = mutation["query"]
                await conn.execute("INSERT INTO user_search_history(id,user_id,query_key,query) VALUES(%s,%s,%s,%s) ON CONFLICT(user_id,query_key) DO UPDATE SET query=excluded.query,searched_at=clock_timestamp()", (uuid4(), who.id, query.lower(), query))
                await conn.execute("DELETE FROM user_search_history WHERE user_id=%s AND id NOT IN (SELECT id FROM user_search_history WHERE user_id=%s ORDER BY searched_at DESC,id DESC LIMIT 20)", (who.id, who.id))
            elif mutation["action"] == "remove":
                await conn.execute("DELETE FROM user_search_history WHERE user_id=%s AND id=%s", (who.id, UUID(mutation["id"])))
            else:
                await conn.execute("DELETE FROM user_search_history WHERE user_id=%s", (who.id,))
            current += 1
            await conn.execute("UPDATE user_search_history_state SET revision=%s WHERE user_id=%s", (current, who.id))
        rows = await (await conn.execute("SELECT id,query,searched_at FROM user_search_history WHERE user_id=%s ORDER BY searched_at DESC,id DESC LIMIT 20", (who.id,))).fetchall()
    return JSONResponse({"revision": current, "items": [{"id": str(r["id"]), "query": r["query"], "searchedAt": r["searched_at"].isoformat()} for r in rows], "conflict": conflict}, status_code=409 if conflict else 200, headers=PRIVATE)


@router.get("/api/auth/search-history")
async def search_history(request: Request, who: Member):
    parameters(request)
    await budget(request, who, "fire-search-history")
    return await history(request, who)


@router.post("/api/auth/search-history")
@router.delete("/api/auth/search-history")
async def change_search_history(request: Request, who: Member):
    parameters(request)
    await budget(request, who, "fire-search-history")
    raw = await body(request, ("action", "revision", "query", "id"), limit=2048)
    return await history(request, who, search_mutation(raw, request.method))


@router.get("/api/users/{user_id}/passkeys")
async def admin_passkeys(user_id: str, request: Request, who: Member):
    if who.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    parameters(request)
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        if not await (await conn.execute("SELECT 1 FROM users WHERE id=%s", (user_id,))).fetchone():
            raise HTTPException(404, "用户不存在")
        keys = await (await conn.execute("SELECT id,name,rp_id,created_at,last_used_at FROM identity_passkeys WHERE user_id=%s ORDER BY created_at DESC,id", (user_id,))).fetchall()
    return JSONResponse({"keys": [{"id": str(k["id"]), "name": k["name"], "rpID": k["rp_id"], "createdAt": int(k["created_at"].timestamp() * 1000), "lastUsedAt": int(k["last_used_at"].timestamp() * 1000) if k["last_used_at"] else None} for k in keys]}, headers=PRIVATE)


@router.get("/api/assets/catalog")
async def asset_catalog(request: Request, who: Member):
    if who.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    parameters(request, ("type", "market", "q", "page", "removed"))
    kind = request.query_params.get("type", "market")
    market = request.query_params.get("market", "ALL")
    q = request.query_params.get("q", "")
    if kind not in KINDS or len(q) > 200 or len(market) > 24 or request.query_params.get("removed", "0") not in {"0", "1"}:
        raise HTTPException(400, "素材筛选无效")
    service = request.app.state.asset_catalog_management
    async with service.catalog.context(who) as conn:
        preferences = (await (await conn.execute("SELECT broker_order FROM fire_catalog_preferences WHERE singleton")).fetchone())["broker_order"]
        site = await (await conn.execute("SELECT settings FROM site_settings WHERE singleton")).fetchone()
        market_order = (site["settings"].get("assetMarketOrder", []) if site else []) + list(MARKETS)
        value = await service.listing(kind=kind, q=q, page=page_number(request.query_params.get("page")), clamp=True, deleted=request.query_params.get("removed") == "1", connection=conn, directory={"market": market, "brokerOrder": preferences, "marketOrder": market_order})
    value["revision"] = str(value["revision"])
    value["assets"] = [{**{k: item.get(k, "") for k in ("id", "type", "market", "code", "name", "url", "urlDark", "imageUrl", "imageUrlDark")}, "brokerMarkets": item.get("brokerMarkets", [])} for item in value["assets"]]
    return JSONResponse(value, headers=PRIVATE)


async def catalog_material(service, conn, aid):
    row = await (await conn.execute("SELECT * FROM asset_catalog_entries WHERE id=%s", (aid,))).fetchone()
    if row is None and service.legacy_directory is not None:
        row = next((r for r in await service.legacy_directory.entries() if r["id"] == aid), None)
    if row is None and service.legacy_card_directory is not None:
        from .card_public_assets import CardPublicAssets
        row = await CardPublicAssets(service.catalog.db, service.legacy_card_directory).source(aid)
    if row is None and aid.startswith("market:"):
        from .legacy_asset_directory import MARKET_NAMES
        key = aid.removeprefix("market:")
        if key in MARKET_NAMES and key != "SPX":
            row = {"id": aid, "type": "market", "market": key, "code": key, "name": MARKET_NAMES[key], "fileVariants": []}
    if row is None or row["type"] not in KINDS:
        raise HTTPException(409, "素材不存在或不属于公共目录，请重新读取")
    return row


@router.post("/api/assets/catalog")
async def change_asset_catalog(request: Request, who: Member):
    parameters(request)
    if who.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    await budget(request, who, "fire-catalog", 30)
    raw = await body(request, ("action", "ids", "revision", "markets", "name", "requestId"), limit=32768)
    action, ids = raw.get("action"), raw.get("ids")
    fields = {"action", "ids", "revision", "requestId"} | ({"markets"} if action == "classify" else {"name"} if action == "rename" else set())
    if action == "rename" and "markets" in raw:
        fields.add("markets")
    if not isinstance(action, str) or action not in {"remove", "restore", "classify", "order", "rename"} or set(raw) != fields or not isinstance(ids, list) or not 1 <= len(ids) <= 100 or any(not isinstance(a, str) or not a or len(a) > 2048 for a in ids) or len(set(ids)) != len(ids):
        raise HTTPException(400, "素材操作无效")
    if action == "rename" and (len(ids) != 1 or not isinstance(raw.get("name"), str) or not raw["name"].strip() or len(raw["name"]) > 120):
        raise HTTPException(400, "素材名称无效")
    rid = identifier(raw["requestId"])
    expected = raw["revision"]
    if not isinstance(expected, str) or not re.fullmatch(r"0|[1-9][0-9]{0,15}", expected):
        raise HTTPException(400, "目录版本无效")
    expected = revision(int(expected))
    markets = raw.get("markets")
    if (action == "classify" or "markets" in raw) and (not isinstance(markets, list) or len(markets) > len(MARKETS) or any(m not in MARKETS for m in markets) or len(set(markets)) != len(markets)):
        raise HTTPException(400, "券商市场分类无效")
    service = request.app.state.asset_catalog_management
    fp = fingerprint(raw)
    async with service.catalog.context(who, True) as conn:
        prior = await (await conn.execute("SELECT fingerprint,result FROM fire_catalog_operations WHERE actor_id=%s AND request_id=%s", (who.id, rid))).fetchone()
        if prior:
            if prior["fingerprint"] != fp:
                raise HTTPException(409, "原请求编号已用于其他操作")
            return JSONResponse(prior["result"], headers=PRIVATE)
        current = (await (await conn.execute("SELECT revision FROM asset_catalog_scope FOR UPDATE")).fetchone())["revision"]
        if current != expected or current + len(ids) >= 9007199254740991:
            raise HTTPException(409, "公共素材目录已变化，请重新读取")
        materials = [await catalog_material(service, conn, aid) for aid in ids]
        if (action in {"classify", "order"} or "markets" in raw) and any(r["type"] != "broker" for r in materials):
            raise HTTPException(400, "请选择券商素材")
        if action == "order":
            old = (await (await conn.execute("SELECT broker_order FROM fire_catalog_preferences WHERE singleton FOR UPDATE")).fetchone())["broker_order"]
            selected = iter(ids)
            order = [next(selected) if aid in ids else aid for aid in old]
            order += [aid for aid in ids if aid not in old]
            await conn.execute("UPDATE fire_catalog_preferences SET broker_order=%s WHERE singleton", (Jsonb(order),))
            await conn.execute("UPDATE asset_catalog_scope SET revision=revision+1")
            current += 1
        else:
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('card-catalog',0))")
            from .system_assets import SystemAssets
            async with SystemAssets(service.catalog.db).context(who, True, connection=conn):
                for row in materials:
                    child = uuid5(rid, action + ":" + row["id"])
                    if action in {"classify", "rename"}:
                        result = await service.write(who, child, current, {"id": row["id"], "name": raw.get("name", row["name"]), **({"brokerMarkets": markets} if markets is not None else {})}, rename=True, connection=conn, broker_market_scope=MARKETS)
                    else:
                        result = await service.delete(who, child, current, row["id"], connection=conn, restore=action == "restore")
                    current = result["revision"]
        result = {"requestId": str(rid), "revision": str(current), "action": action, "ids": ids}
        await conn.execute("INSERT INTO fire_catalog_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)", (who.id, rid, fp, Jsonb(result)))
        await conn.execute("INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,%s,%s)", (who.id, "assets.catalog." + action, request.state.request_id))
    return JSONResponse(result, headers=PRIVATE)
