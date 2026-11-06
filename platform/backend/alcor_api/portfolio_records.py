"""One record authority shared by portfolio and watchlist views.

User-entered balances are not broker fills. Prepared mutations are durable, versioned,
and confirmed exactly once; account/source/history checks run again at commit.
"""

import re
from decimal import Decimal, InvalidOperation
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .security import digest, lock_mutation_identity

TEXT_LIMITS = {"name": 100, "code": 40, "market": 40, "group": 100, "note": 500, "source": 50,
               "watchGroupId": 100, "brokerAccountId": 100, "accountMarket": 40}
ALIASES = {"USA": "US", "NASDAQ": "US", "NYSE": "US", "AMEX": "US", "OTC": "US", "美股": "US",
           "HONGKONG": "HK", "港股": "HK", "A": "CN", "SH": "CN", "SZ": "CN", "BJ": "CN",
           "SSE": "CN", "SZSE": "CN", "A股": "CN", "沪": "CN", "深": "CN", "SGX": "SG",
           "SINGAPORE": "SG", "新加坡": "SG", "JAPAN": "JP", "T": "JP", "TYO": "JP", "日股": "JP",
           "KOREA": "KR", "KS": "KR", "KQ": "KR", "KOSPI": "KR", "韩股": "KR", "L": "UK", "LSE": "UK"}


def fail(message, status=400):
    raise HTTPException(status, message)


def text(value, limit, *, required=False):
    if not isinstance(value, str) or len(value.encode("utf-16-le")) // 2 > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
        fail("文本参数无效")
    value = value.strip()
    if required and not value:
        fail("缺少必填字段")
    return value


def number(value, *, negative=False):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, str | int | Decimal):
        fail("金额或数量无效")
    raw = str(value)
    if len(raw) > 80:
        fail("金额或数量超出范围")
    try:
        number = Decimal(raw)
    except InvalidOperation:
        fail("金额或数量无效")
    if not number.is_finite() or abs(number) >= Decimal("1e30") or number.as_tuple().exponent < -18 or (not negative and number < 0):
        fail("金额或数量超出范围")
    return format(number, "f")


def symbol(raw, market):
    code = raw.upper()
    normalized_market = ALIASES.get(market.upper(), market.upper())
    prefix = re.fullmatch(r"(US|HK|CN|SH|SZ|BJ|SG|JP|KR|UK)[.:]([A-Z0-9._-]+)", code)
    prefix = prefix or re.fullmatch(r"(HK)(\d{1,5})", code) or re.fullmatch(r"(SH|SZ|BJ)(\d{6})", code)
    suffix = re.fullmatch(r"(.+)\.(US|HK|CN|SG|JP|KR|UK)", code)
    explicit = ALIASES.get(prefix[1], prefix[1]) if prefix else suffix[2] if suffix else ""
    if explicit and explicit != normalized_market:
        fail("股票市场与代码前缀不一致")
    if prefix:
        code = prefix[2]
    elif suffix:
        code = suffix[1]
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9._-]{0,39}", code):
        fail("股票代码无效")
    if normalized_market == "HK" and re.fullmatch(r"\d{1,5}", code):
        code = code.zfill(5)
    if normalized_market == "US":
        code = re.sub(r"\.(AM|N|OQ|PS|K)$", "", code)
    elif normalized_market == "JP":
        code = re.sub(r"\.T$", "", code)
    elif normalized_market == "KR":
        code = re.sub(r"\.(KS|KQ)$", "", code)
    return code


def record_dto(row):
    return {
        "id": row["id"], "name": row["name"], "code": row["code"], "market": row["market"],
        "accountMarket": row["account_market"],
        **{key: None if row[key] is None else format(row[key], "f") for key in ("price", "cost", "qty")},
        "group": row["group_name"], "brokerAccountId": row["broker_account_id"] or "",
        "watchGroupId": row["watch_group_id"] or "", "watchGroupSort": row["watch_group_sort"],
        "note": row["note"], "source": row["source"], "revision": row["revision"],
        "updatedAt": row["updated_at"].isoformat(), "historyState": row["history_state"],
    }


def normalize(data, old=None):
    if not isinstance(data, dict) or set(data) - (set(TEXT_LIMITS) | {"price", "cost", "qty"}):
        fail("请求含未知字段")
    required = {"name", "code", "market", "price", "cost", "qty", "group", "note"}
    if not required <= set(data):
        fail("缺少必填字段")
    result = {key: text(data.get(key, ""), limit, required=key in {"name", "code", "market"}) for key, limit in TEXT_LIMITS.items()}
    result["code"] = symbol(result["code"], result["market"])
    for key in ("price", "cost", "qty"):
        result[key] = number(data[key], negative=key == "cost")
    if old:
        for key, column in (("brokerAccountId", "broker_account_id"), ("watchGroupId", "watch_group_id")):
            if key not in data:
                result[key] = old[column] or ""
        if "accountMarket" not in data and result["market"] == "HK":
            result["accountMarket"] = old["account_market"]
    if result["accountMarket"] not in {"", result["market"]} and not (result["market"] == "HK" and result["accountMarket"] == "CN"):
        fail("港股通须保留 HK 行情市场并归属 CN 账户")
    if result["market"] != "HK":
        result["accountMarket"] = ""
    return result


class PortfolioRecords:
    def __init__(self, db):
        self.db = db

    async def apply_metadata_on_connection(self,conn,owner,record_id,old,data):
        """Shared checked update; caller owns the transaction, identity and record locks."""
        await self.check(conn,owner,'update',old,data)
        values=(data['name'],data['code'],data['market'],data['accountMarket'],data['price'],data['cost'],data['qty'],data['group'],data['brokerAccountId'] or None,data['watchGroupId'] or None,data['note'],data['source'])
        return await(await conn.execute("UPDATE portfolio_records SET name=%s,code=%s,market=%s,account_market=%s,price=%s,cost=%s,qty=%s,group_name=%s,broker_account_id=%s,watch_group_id=%s,note=%s,source=%s,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s RETURNING *",(*values,owner,record_id))).fetchone()

    async def read_lock(self, conn, owner, authorization=None):
        """Current owner proof without initializing an empty collection on a GET."""
        if authorization is not None:
            if authorization.id != owner:
                fail("账号不匹配",403)
            await lock_mutation_identity(conn,authorization,require_admin=False)
        else:
            user=await(await conn.execute('SELECT active FROM users WHERE id=%s FOR SHARE',(owner,))).fetchone()
            if not user or not user['active']:
                fail('账号不可用',403)
        row=await(await conn.execute('SELECT revision FROM portfolio_record_collections WHERE owner_id=%s',(owner,))).fetchone()
        return row['revision'] if row else 0

    async def lock(self, conn, owner, authorization=None):
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + owner,))
        user = await (await conn.execute("SELECT active FROM users WHERE id=%s FOR SHARE", (owner,))).fetchone()
        if not user or not user["active"]:
            fail("账号不可用", 403)
        if authorization is not None:
            if authorization.id != owner:
                fail("账号不匹配", 403)
            await lock_mutation_identity(conn, authorization, require_admin=False)
        await conn.execute("INSERT INTO portfolio_record_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING", (owner,))
        row = await (await conn.execute("SELECT revision FROM portfolio_record_collections WHERE owner_id=%s FOR UPDATE", (owner,))).fetchone()
        return row["revision"]

    async def list(self, owner, *, page=1, page_size=100, collection_revision=None, market="", group="", view="", broker_account_id="", display_revision=None, display_mode="all"):
        if type(page) is not int or not 1 <= page <= 1_000_000 or type(page_size) is not int or not 1 <= page_size <= 100:
            fail("分页参数无效")
        if display_mode not in ("all","watch"):
            fail("显示模式无效")
        if display_mode=="watch" and page>1 and display_revision is None:
            fail("自选续页需要原显示版本",409)
        market, group, view = text(market, 40), text(group, 100), text(view, 100)
        view = view or ("market:" + market if market else "__all")
        custom = view != "__all" and not view.startswith("market:")
        if view.startswith("market:") and (not view[7:] or (market and market != view[7:])):
            fail("市场排序视图无效")
        if view.startswith("market:"):
            market = view[7:]
        async with self.db.connection() as conn, conn.transaction():
            revision = await self.lock(conn, owner)
            from .scope_coverage import account_status, limited, require_global
            if broker_account_id:
                if not await account_status(conn,owner,broker_account_id):limited({"accountId":broker_account_id,"complete":False})
            else:await require_global(conn,owner)
            if collection_revision is not None and (type(collection_revision) is not int or collection_revision != revision):
                fail("记录已变化，请重新读取第一页", 409)
            if custom:
                owned = await (await conn.execute("SELECT 1 FROM watch_groups WHERE owner_id=%s AND id=%s AND kind='custom' AND deleted_at IS NULL", (owner, view))).fetchone()
                if not owned:
                    fail("分组不存在", 404)
            overlay_revision=None
            extra_ids,moved_ids,moved_here=[],[],[]
            hidden_ids,pinned_ids,display_order=[],[],[]
            if custom or display_mode=="watch":
                import json

                from .market_contract import digest
                from .watch_state_contract import canonical, validate_fields
                installed=await(await conn.execute("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0047_watch_display.sql') AS installed,to_regclass('public.watch_display_fields') IS NOT NULL AS present")).fetchone()
                if installed['installed']!=installed['present']:
                    fail('自选显示偏好结构尚未完整可用',503)
                fields=await(await conn.execute('SELECT field,revision,value FROM watch_display_fields WHERE owner_id=%s ORDER BY field COLLATE "C" LIMIT 10001',(owner,))).fetchall() if installed['present'] else []
                if len(fields)>10000 or len(canonical({row['field']:row['value'] for row in fields}).encode())>4*1024*1024:
                    fail('自选显示偏好超过完整读取范围',503)
                try:
                    validate_fields({row['field']:row['value'] for row in fields})
                except HTTPException:
                    fail('已保存自选显示偏好无法完整核对',503)
                overlay_revision=digest({'owner':owner,'view':view,'displayMode':display_mode,'fields':[(row['field'],row['revision'],row['value']) for row in fields]})
                if display_revision is not None and display_revision!=overlay_revision:
                    fail('自选显示成员已变化，请重新读取第一页',409)
                moved={};extras=set();hidden=set();pinned=set();order=None
                selection="ALL" if view=="__all" else view
                for field in fields:
                    value=field['value']
                    if value is None:
                        continue  # Historical unknown tombstone keys need not be JSON.
                    parts=json.loads(field['field'])
                    if parts[0]=='moved' and len(parts)==2:
                        if parts[1] in moved and moved[parts[1]]!=value:
                            fail('同一记录有多个显示归属声明，请核对原偏好字段',409)
                        moved[parts[1]]=value
                    elif parts[0]=='groups' and len(parts)==3 and parts[1]==view and value is True:
                        extras.add(parts[2])
                    elif parts[0]=='hidden' and len(parts)==2 and value is True:
                        hidden.add(parts[1])
                    elif parts[0]=='pinned' and len(parts)==2 and value is True:
                        pinned.add(parts[1])
                    elif parts[0]=='orders' and len(parts)==2 and parts[1]==selection and display_mode=='watch':
                        if order is not None and order!=value:
                            fail('同一视图存在多个排序声明，请核对原偏好字段',409)
                        order=value
                hidden_ids=sorted(hidden);pinned_ids=sorted(pinned);display_order=order or []
                # AlcorWatchDisplay.belongs: extra membership OR moved target;
                # only without a moved declaration does the persisted base group apply.
                extra_ids=sorted(extras)
                moved_ids=sorted(moved)
                moved_here=sorted(key for key,value in moved.items() if value==view)
            elif display_revision is not None:
                fail('自选显示视图已变化，请重新读取第一页',409)
            where = "r.owner_id=%s AND r.deleted_at IS NULL AND (%s='' OR r.market=%s) AND (%s='' OR r.group_name=%s)"
            where += " AND (NOT %s OR r.id=ANY(%s::text[]) OR (CASE WHEN r.id=ANY(%s::text[]) THEN r.id=ANY(%s::text[]) ELSE r.watch_group_id=%s END))"
            where += " AND (%s='' OR r.broker_account_id=%s) AND (NOT %s OR NOT r.id=ANY(%s::text[]))"
            params = (owner, market, market, group, group, custom,extra_ids,moved_ids,moved_here,view,broker_account_id,broker_account_id,display_mode=="watch",hidden_ids)
            count = await (await conn.execute("SELECT count(*) AS total FROM portfolio_records r WHERE " + where, params)).fetchone()
            order_sql="CASE WHEN %s THEN r.watch_group_sort ELSE o.sort END NULLS LAST,o.sort NULLS LAST,r.updated_at DESC,r.id"
            order_params=(custom,)
            if display_mode=="watch":
                order_sql="(r.id=ANY(%s::text[])) DESC,array_position(%s::text[],r.id) NULLS LAST,"+order_sql
                order_params=(pinned_ids,display_order,*order_params)
            rows = await (await conn.execute("SELECT r.* FROM portfolio_records r LEFT JOIN portfolio_record_orderings o ON o.owner_id=r.owner_id AND o.record_id=r.id AND o.view_id=%s WHERE " + where + " ORDER BY "+order_sql+" LIMIT %s OFFSET %s", (view, *params, *order_params, page_size, (page-1)*page_size))).fetchall()
            return {"records": [await self.actual_dto(conn,owner,r) for r in rows], "collectionRevision": revision, "total": count["total"], "page": page, "pageSize": page_size,
                    "displayMode":display_mode,"displayRevision":overlay_revision,"membershipBasis":"watch_display_moved_and_extra_groups" if custom else "portfolio_record_filter"}

    async def snapshot(self, owner, record_id):
        record_id = text(record_id, 100, required=True)
        async with self.db.connection() as conn, conn.transaction():
            revision = await self.lock(conn, owner)
            from .scope_coverage import require_record
            await require_record(conn,owner,record_id)
            row = await self.get(conn, owner, record_id)
            if not row:
                fail("记录不存在", 404)
            return {"record": await self.actual_dto(conn,owner,row), "collectionRevision": revision}

    async def actual_dto(self,conn,owner,row):
        from .actual_projection import actual_record_dto
        return await actual_record_dto(conn,owner,row)

    async def get(self, conn, owner, record_id):
        return await (await conn.execute("SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL FOR UPDATE", (owner, record_id))).fetchone()

    async def check(self, conn, owner, kind, old, data):
        if kind != "create" and not old:
            fail("记录不存在", 404)
        if old:
            changes_basis = kind == "delete" or data is not None and (
                any(data[field] != (old[column] or "") for field, column in (
                    ("code", "code"), ("market", "market"), ("accountMarket", "account_market"),
                    ("brokerAccountId", "broker_account_id"), ("source", "source"),
                )) or any((None if data[field] is None else Decimal(data[field])) != old[field] for field in ("qty", "cost"))
            )
            if changes_basis:
                active = await (await conn.execute(
                    "SELECT 1 FROM internal_orders WHERE owner_id=%s AND record_id=%s AND status IN ('pending','imported_suspended') LIMIT 1",
                    (owner, old["id"]),
                )).fetchone()
                if active:
                    fail("记录仍有待处理订单，请先显式处理订单再修改记录依据", 409)
        if old and old.get("position_transfer_id"):
            if kind == "delete":
                fail("记录已有转仓凭证，须保留原归属及历史", 409)
            if data is not None:
                identity_changed = any(data[field] != (old[column] or "") for field, column in (
                    ("code", "code"), ("market", "market"), ("accountMarket", "account_market"),
                    ("brokerAccountId", "broker_account_id"), ("source", "source"),
                ))
                economics_changed = any((None if data[field] is None else Decimal(data[field])) != old[field] for field in ("qty", "cost"))
                if identity_changed or economics_changed:
                    fail("转仓记录身份与数量成本不能由元数据改写，请使用成交或显式转仓", 409)
        if kind == "delete":
            if old["history_state"] != "empty":
                fail("成交历史未确认为空，不能删除", 409)
            # A non-empty current holding needs an explicit accounting operation, never a metadata deletion.
            if old["qty"] is not None and old["qty"] != 0:
                fail("记录仍有持仓，不能删除", 409)
        if old and old["history_state"] == "has_trades" and data is not None:
            changed_identity = any(data[field] != (old[column] or "") for field, column in (
                ("code", "code"), ("market", "market"), ("accountMarket", "account_market"),
                ("brokerAccountId", "broker_account_id"), ("source", "source"),
            ))
            changed_amount = any((None if data[field] is None else Decimal(data[field])) != old[field] for field in ("qty", "cost"))
            if changed_identity or changed_amount:
                fail("记录含成交历史，请通过成交更正修改金融字段", 409)
        if old and data is not None and data['brokerAccountId'] != (old['broker_account_id'] or '') and (old['history_state'] != 'empty' or old['qty'] is not None and old['qty'] != 0):
            fail('历史未核对或记录仍有数量，须单独核对转仓',409)
        account_ids = {v for v in ((old or {}).get("broker_account_id"), (data or {}).get("brokerAccountId")) if v}
        accounts = {}
        for account_id in sorted(account_ids):
            account = await (await conn.execute("SELECT * FROM broker_accounts WHERE owner_id=%s AND id=%s AND deleted_at IS NULL FOR SHARE", (owner, account_id))).fetchone()
            if not account:
                fail("券商账户不存在", 404)
            if account["holding_source"] == "official":
                fail("官方管理账户不能手动修改持仓", 409)
            accounts[account_id] = account
        dependencies = {"account:" + key: value["revision"] for key, value in accounts.items()}
        if data is None:
            return dependencies
        group_id = data["watchGroupId"]
        if group_id:
            group = await (await conn.execute("SELECT kind,revision FROM watch_groups WHERE owner_id=%s AND id=%s AND deleted_at IS NULL FOR SHARE", (owner, group_id))).fetchone()
            if not group or group["kind"] != "custom":
                fail("自选组不存在", 404)
            dependencies["group:" + group_id] = group["revision"]
        account_id = data["brokerAccountId"]
        if account_id:
            previous_account=(old or {}).get('broker_account_id')
            if previous_account and previous_account!=account_id and accounts[previous_account]['account_kind']!=accounts[account_id]['account_kind']:
                fail('不同账本类型或未核对归属不能通过元数据转移',409)
            if old:
                claim=await(await conn.execute('SELECT account_kind FROM broker_record_scope_claims WHERE owner_id=%s AND record_id=%s',(owner,old['id']))).fetchone()
                if claim and claim['account_kind']!=accounts[account_id]['account_kind']:
                    fail('记录已有不同账本归属，须单独核对转仓',409)
            data["group"] = accounts[account_id]["name"]
            account_market = data["accountMarket"] or data["market"]
            old_key = (old["broker_account_id"], old["market"], old["code"], old["account_market"] or old["market"]) if old else None
            next_key = (account_id, data["market"], data["code"], account_market)
            if old_key != next_key:
                duplicate = await (await conn.execute(
                    "SELECT 1 FROM portfolio_records WHERE owner_id=%s AND broker_account_id=%s AND market=%s AND code=%s AND COALESCE(NULLIF(account_market,''),market)=%s AND id<>%s AND deleted_at IS NULL",
                    (owner, account_id, data["market"], data["code"], account_market, old["id"] if old else ""),
                )).fetchone()
                if duplicate:
                    fail("同一账户已存在该证券，请编辑原持仓", 409)
        return dependencies

    def authorization_binding(self, owner, authorization):
        if authorization is None:
            return digest("portfolio:internal:" + owner)
        return digest("portfolio:session:" + owner + ":" + authorization.token_hash)

    async def preview(self, owner, kind, data, *, record_id="", revision=None, authorization=None, source_create_id=None):
        if kind not in {"create", "update", "delete"}:
            fail("操作无效")
        if kind != "create" and (not isinstance(record_id, str) or not 1 <= len(record_id) <= 100 or type(revision) is not int or revision < 1):
            fail("记录编号或版本无效")
        if kind == "create" and (record_id or revision is not None):
            fail("新建请求不接受旧记录版本")
        if kind == "delete" and data:
            fail("删除请求不接受记录字段")
        if source_create_id is not None and (kind != "create" or not isinstance(source_create_id,str) or not re.fullmatch(r"r-[a-f0-9]{32}",source_create_id)):
            fail("来源记录编号无效")
        async with self.db.connection() as conn, conn.transaction():
            collection = await self.lock(conn, owner, authorization)
            old = await self.get(conn, owner, record_id) if kind != "create" else None
            if old and old["revision"] != revision:
                fail("记录已变化，请重新读取后确认", 409)
            normalized = None if kind == "delete" else normalize(data, old)
            dependencies = await self.check(conn, owner, kind, old, normalized)
            preview_id = uuid4()
            record_id = record_id or source_create_id or "r-" + uuid4().hex
            row = await (await conn.execute(
                "INSERT INTO portfolio_record_previews(owner_id,id,kind,record_id,record_revision,collection_revision,normalized_input,dependencies,authorization_binding) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at",
                (owner, preview_id, kind, record_id, revision, collection, Jsonb(normalized), Jsonb(dependencies), self.authorization_binding(owner, authorization)),
            )).fetchone()
            return {"previewId": str(preview_id), "kind": kind, "recordId": record_id, "before": record_dto(old) if old else None, "after": normalized, "collectionRevision": collection, "expiresAt": row["expires_at"].isoformat()}

    async def confirm(self, owner, preview_id, request_id, *, authorization=None):
        try:
            preview_id, request_id = UUID(str(preview_id)), UUID(str(request_id))
        except ValueError:
            fail("请求编号无效")
        async with self.db.connection() as conn, conn.transaction():
            collection = await self.lock(conn, owner, authorization)
            prior = await (await conn.execute("SELECT 1 FROM portfolio_request_reservations WHERE owner_id=%s AND request_id=%s", (owner, request_id))).fetchone()
            if prior:
                fail("requestId 已使用，请只读查询原操作", 409)
            preview = await (await conn.execute("SELECT *,expires_at>clock_timestamp() AS valid FROM portfolio_record_previews WHERE owner_id=%s AND id=%s FOR UPDATE", (owner, preview_id))).fetchone()
            if not preview or not preview["valid"] or preview["consumed_at"] is not None:
                fail("预览已失效，请重新预览", 409)
            if preview["authorization_binding"] != self.authorization_binding(owner, authorization):
                fail("预览不属于当前会话，请重新预览", 409)
            if collection != preview["collection_revision"]:
                fail("记录集合已变化，请重新预览", 409)
            kind, record_id, data = preview["kind"], preview["record_id"], preview["normalized_input"]
            old = await self.get(conn, owner, record_id) if kind != "create" else None
            if old and old["revision"] != preview["record_revision"]:
                fail("记录已变化，请重新预览", 409)
            dependencies = await self.check(conn, owner, kind, old, data)
            if dependencies != preview["dependencies"]:
                fail("账户或分组已变化，请重新预览", 409)
            if kind == "delete":
                row = await (await conn.execute("UPDATE portfolio_records SET deleted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s RETURNING *", (owner, record_id))).fetchone()
            else:
                values = (data["name"], data["code"], data["market"], data["accountMarket"], data["price"], data["cost"], data["qty"], data["group"], data["brokerAccountId"] or None, data["watchGroupId"] or None, data["note"], data["source"])
                if kind == "create":
                    row = await (await conn.execute("INSERT INTO portfolio_records(owner_id,id,name,code,market,account_market,price,cost,qty,group_name,broker_account_id,watch_group_id,note,source,history_state) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'empty') RETURNING *", (owner, record_id, *values))).fetchone()
                else:
                    row = await self.apply_metadata_on_connection(conn,owner,record_id,old,data)
            current = await (await conn.execute("SELECT revision FROM portfolio_record_collections WHERE owner_id=%s", (owner,))).fetchone()
            result = {"requestId": str(request_id), "previewId": str(preview_id), "kind": kind, "recordId": record_id, "state": "completed", "record": None if kind == "delete" else record_dto(row), "deleted": kind == "delete", "revision": row["revision"], "collectionRevision": current["revision"]}
            await conn.execute("UPDATE portfolio_record_previews SET consumed_at=clock_timestamp() WHERE owner_id=%s AND id=%s", (owner, preview_id))
            await conn.execute("INSERT INTO portfolio_record_operations(owner_id,request_id,preview_id,result) VALUES(%s,%s,%s,%s)", (owner, request_id, preview_id, Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)", (owner, "portfolio-records." + kind, record_id, request_id))
            return result

    async def receipt(self, owner, request_id):
        try:
            request_id = UUID(str(request_id))
        except ValueError:
            fail("请求编号无效")
        async with self.db.connection() as conn:
            row = await (await conn.execute("SELECT result FROM portfolio_record_operations WHERE owner_id=%s AND request_id=%s", (owner, request_id))).fetchone()
            if not row:
                fail("未找到已提交回执", 404)
            return row["result"]
