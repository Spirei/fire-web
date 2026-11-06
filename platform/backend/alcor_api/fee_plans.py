"""Confirmed personal fee plans: versioned evidence, never historical cash writes."""

import secrets
from decimal import ROUND_HALF_UP, Decimal, localcontext
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account
from .cash_ledger import CashLedger, fingerprint
from .fee_rules import day, number
from .security import digest, lock_mutation_identity


def normalize(raw):
    if isinstance(raw, dict) and ({"market", "legacyOriginal"} & raw.keys()):
        from .fee_plan_sources import normalize as rich_normalize
        return rich_normalize(raw, validate_rule)
    keys = {
        "requestId",
        "planId",
        "revision",
        "accountId",
        "providerId",
        "effectiveFrom",
        "effectiveThrough",
        "components",
        "confirmed",
    }
    if not isinstance(raw, dict) or set(raw) != keys or raw["confirmed"] is not True:
        raise HTTPException(422, "须确认完整个人费率")
    value = dict(raw)
    try:
        for key in ("requestId", "planId"):
            value[key] = str(UUID(raw[key]))
        if type(raw["revision"]) is not int or raw["revision"] < 0:
            raise ValueError()
        if raw["providerId"] not in ("longbridge", "huatai"):
            raise ValueError()
        if day(raw["effectiveFrom"]) > day(raw["effectiveThrough"]):
            raise ValueError()
        if (
            not isinstance(raw["components"], dict)
            or not raw["components"]
            or set(raw["components"]) - {"commission", "platform", "fundCommission"}
        ):
            raise ValueError()
        value["components"] = {key: validate_rule(rule) for key, rule in raw["components"].items()}
    except (ValueError, TypeError, KeyError):
        raise HTTPException(422, "个人费率参数无效") from None
    return value


def validate_rule(rule):
    from .fee_plan_sources import decimal_value
    keys = {"basis", "rate", "minimum", "maximum", "maximumPercent", "minimumWins", "side", "tiers", "graduated"}
    if not isinstance(rule, dict) or set(rule)-keys or rule.get("basis") not in ("free", "share", "contract", "order", "percent", "permille"):
        raise ValueError("rule_invalid")
    rich = "tiers" in rule or "graduated" in rule or rule["basis"] in ("contract","free") or "rate" in rule and rule["rate"] is None
    result = dict(rule)
    for key in ("minimumWins", "graduated"):
        if key in rule and type(rule[key]) is not bool:
            raise ValueError("minimum_or_tier_policy_invalid")
    if rule.get("side", "both") not in ("both", "buy", "sell"):
        raise ValueError("side_invalid")
    numeric = {"rate", "minimum", "maximum", "maximumPercent"}
    if rule["basis"] == "free":
        if any(rule.get(key) is not None for key in numeric) or rule.get("tiers"):
            raise ValueError("free_not_explicit")
    elif not rich and "rate" not in rule:
        raise ValueError("rate_missing")
    for key in numeric & rule.keys():
        if rule[key] is None:
            if not rich:
                raise ValueError("numeric_null_invalid")
        else:
            result[key] = format(decimal_value(rule[key]), "f") if rich else str(number(rule[key]))
    if Decimal(result.get("maximumPercent") or "0") > 100:
        raise ValueError("cap_invalid")
    limit = 100 if rule["basis"] == "percent" else 1000 if rule["basis"] == "permille" else None
    if limit is not None and Decimal(result.get("rate") or "0") > limit:
        raise ValueError("rate_invalid")
    if "tiers" in rule:
        tiers = rule["tiers"]
        if not isinstance(tiers, list) or len(tiers) > 12:
            raise ValueError("tiers_invalid")
        normalized = []
        previous = None
        for tier in tiers:
            if not isinstance(tier, dict) or set(tier) != {"from", "rate"}:
                raise ValueError("tier_invalid")
            start, rate = decimal_value(tier["from"]), decimal_value(tier["rate"])
            if previous is None and start != 0 or previous is not None and start <= previous or limit is not None and rate > limit:
                raise ValueError("tier_order_or_rate_invalid")
            normalized.append({"from": format(start,"f"), "rate": format(rate,"f")})
            previous = start
        result["tiers"] = normalized
    return result


def calculate_component(rule, quantity, gross, side, *, monthly_before=None, unit_kind=None):
    """Pure rule arithmetic. Caller must prove monthly continuity and contract units;
    the default financial-write path cannot supply those by declaration over HTTP.
    """
    rule = validate_rule(rule)
    if side not in ("buy", "sell"):
        raise ValueError("trade_side_invalid")
    if rule.get("side", "both") not in ("both", side) or rule["basis"] == "free":
        return Decimal(0)
    if rule["basis"] == "contract" and unit_kind != "contracts":
        raise ValueError("fee_contract_unit_evidence_required")
    with localcontext() as context:
        context.prec = 100
        basis = Decimal(1) if rule["basis"] == "order" else number(gross) if rule["basis"] in ("percent", "permille") else number(quantity)
        divisor = 100 if rule["basis"] == "percent" else 1000 if rule["basis"] == "permille" else 1
        tiers = rule.get("tiers", [])
        if tiers:
            from .fee_plan_sources import decimal_value
            if monthly_before is None:
                raise ValueError("fee_monthly_history_required")
            before = decimal_value(monthly_before)
            decimal_value(before+basis)
            if rule.get("graduated", True):
                result = Decimal(0)
                for index,tier in enumerate(tiers):
                    upper = Decimal(tiers[index+1]["from"]) if index+1<len(tiers) else before+basis
                    count = max(Decimal(0), min(before+basis, upper)-max(before,Decimal(tier["from"])))
                    result += count*Decimal(tier["rate"])/divisor
            else:
                tier = next(tier for tier in reversed(tiers) if Decimal(tier["from"])<=before)
                result = basis*Decimal(tier["rate"])/divisor
        else:
            if rule.get("rate") is None:
                raise ValueError("fee_rule_unknown")
            result = basis*Decimal(rule["rate"])/divisor
        caps = [Decimal(rule["maximum"])] if rule.get("maximum") is not None else []
        if rule.get("maximumPercent") is not None:
            caps.append(number(gross)*Decimal(rule["maximumPercent"])/100)
        minimum = Decimal(rule["minimum"]) if rule.get("minimum") is not None else None
        if rule.get("minimumWins",True):
            if caps: result = min(result,*caps)
            if minimum is not None: result = max(result,minimum)
        else:
            if minimum is not None: result = max(result,minimum)
            if caps: result = min(result,*caps)
        if not result.is_finite() or not 0<=result<=Decimal(1000000000000):
            raise ValueError("fee_result_range")
        return result.quantize(Decimal(".01"),rounding=ROUND_HALF_UP)


class FeePlans:
    def __init__(self, db, *, _batch_budget=False):
        self.db = db
        self._batch_budget = _batch_budget
        self.cash = CashLedger(db)

    async def checked(self, conn, who, data):
        account = await broker_account(conn, who.id, data["accountId"])
        if account["account_kind"] not in ("real", "simulated"):
            raise HTTPException(409, "账户真实或模拟身份未知")
        if account["holding_source"] != "manual" or account["provider_id"] != data["providerId"]:
            raise HTTPException(409, "账户来源或券商不匹配")
        current = await (
            await conn.execute(
                "SELECT revision,account_id FROM fee_plan_heads WHERE owner_id=%s AND id=%s FOR UPDATE",
                (who.id, data["planId"]),
            )
        ).fetchone()
        if current and current["account_id"] != data["accountId"]:
            raise HTTPException(404, "本人费率计划不存在")
        if (current["revision"] if current else 0) != data["revision"]:
            raise HTTPException(409, "个人费率已变化")
        if current:
            prior=await(await conn.execute('SELECT provider_id,market FROM fee_plan_revisions WHERE owner_id=%s AND id=%s AND revision=%s',(who.id,data['planId'],current['revision']))).fetchone()
            if prior and (prior['provider_id']!=data['providerId'] or prior['market'] is not None and prior['market']!=data.get('market')):
                raise HTTPException(409,'费率身份或市场已变化，不能省略或改写原市场')
        if "market" in data:
            overlap = await (await conn.execute("SELECT r.market FROM fee_plan_heads h JOIN fee_plan_revisions r ON r.owner_id=h.owner_id AND r.id=h.id AND r.revision=h.revision WHERE h.owner_id=%s AND h.account_id=%s AND h.id<>%s AND h.retired_at IS NULL AND (r.market=%s OR r.market IS NULL) AND r.effective_from<=COALESCE(%s::date,'infinity'::date) AND COALESCE(r.effective_through,'infinity'::date)>=%s::date LIMIT 1", (who.id,data["accountId"],data["planId"],data["market"],data["effectiveThrough"],data["effectiveFrom"]))).fetchone()
            if overlap:
                raise HTTPException(409,"同一账户市场费率期间重叠或旧计划市场未知")
        return account

    async def preview(self, who, raw):
        if not self._batch_budget:await fee_limit(self.db, who)
        data = normalize(raw)
        async with self.db.connection() as conn, conn.transaction():
            await self.cash.lock(conn, who)
            account = await self.checked(conn, who, data)
            token = secrets.token_urlsafe(32)
            row = await (
                await conn.execute(
                    "INSERT INTO fee_plan_previews(token_hash,owner_id,session_hash,payload_hash,account_revision) VALUES(%s,%s,%s,%s,%s) RETURNING expires_at",
                    (digest(token), who.id, who.token_hash, fingerprint(data), account["revision"]),
                )
            ).fetchone()
            return {
                "sourceAccount": {
                    "id": account["id"],
                    "name": account["name"],
                    "providerId": account["provider_id"],
                    "source": account["holding_source"],
                    "accountKind": account["account_kind"],
                },
                "data": data,
                "preview": token,
                "expiresAt": row["expires_at"].isoformat(),
                "cashEffect": None,
                "historicalRecalculation": False,
            }

    async def submit(self, who, raw, preview):
        if not isinstance(preview,str) or not 1<=len(preview)<=128:
            raise HTTPException(422,'预览凭证无效')
        if not self._batch_budget:await fee_limit(self.db, who)
        data = normalize(raw)
        hashed = fingerprint(data)
        async with self.db.connection() as conn, conn.transaction():
            await self.cash.lock(conn, who)
            old = await (
                await conn.execute(
                    "SELECT * FROM fee_plan_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["requestId"]),
                )
            ).fetchone()
            if old:
                if old["payload_hash"] != hashed:
                    raise HTTPException(409, "请求编号已用于其他操作")
                return old["result"]
            account = await self.checked(conn, who, data)
            proof = await (
                await conn.execute(
                    "SELECT * FROM fee_plan_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
                    (digest(preview), who.id, who.token_hash),
                )
            ).fetchone()
            if (
                not proof
                or proof["payload_hash"] != hashed
                or proof["account_revision"] != account["revision"]
            ):
                raise HTTPException(409, "预览失效，请重新核对")
            revision = data["revision"] + 1
            await conn.execute(
                "INSERT INTO fee_plan_heads(owner_id,account_id,id,revision) VALUES(%s,%s,%s,%s) ON CONFLICT(owner_id,id) DO UPDATE SET revision=excluded.revision,retired_at=NULL",
                (who.id, data["accountId"], data["planId"], revision),
            )
            await conn.execute(
                "INSERT INTO fee_plan_revisions(owner_id,id,revision,account_id,provider_id,effective_from,effective_through,components,market,legacy_original_base64) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    who.id,
                    data["planId"],
                    revision,
                    data["accountId"],
                    data["providerId"],
                    data["effectiveFrom"],
                    data["effectiveThrough"],
                    Jsonb(data["components"]),
                    data.get("market"),
                    data.get("legacyOriginal"),
                ),
            )
            result = {
                "requestId": data["requestId"],
                "state": "completed",
                "planId": data["planId"],
                "revision": revision,
                "historicalRecalculation": False,
            }
            await conn.execute(
                "INSERT INTO fee_plan_operations VALUES(%s,%s,%s,%s)",
                (who.id, data["requestId"], hashed, Jsonb(result)),
            )
            await conn.execute(
                "UPDATE fee_plan_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s",
                (digest(preview),),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'fees.plan.confirm',%s,%s)",
                (who.id, data["planId"], data["requestId"]),
            )
            return result

    async def receipt(self, who, request_id):
        async with self.db.connection() as conn,conn.transaction():
            from .account_signals import guard
            await guard(conn,who,'portfolio.read')
            row = await (
                await conn.execute(
                    "SELECT result FROM fee_plan_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, str(UUID(str(request_id)))),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原请求回执不存在")
            return row["result"]

    async def legacy_fields(self, who):
        from .account_signals import guard
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await guard(conn,who,"portfolio.read")
            return await self.legacy_fields_on_connection(conn,who)

    async def legacy_fields_on_connection(self,conn,who):
        from .fee_plan_sources import original, platform_projection
        rows=await (await conn.execute("SELECT r.*,h.revision AS current_revision,h.retired_at FROM fee_plan_heads h JOIN fee_plan_revisions r ON r.owner_id=h.owner_id AND r.id=h.id WHERE h.owner_id=%s ORDER BY r.id,r.revision LIMIT 6001",(who.id,))).fetchall()
        if len(rows)>6000:
            raise HTTPException(409,"费率历史超出当前读取范围")
        fields,provenance,source_ids={},{},{}
        for stored in rows:
            if stored['legacy_original_base64'] is not None:
                try:
                    source_id=original(stored['legacy_original_base64'])['id']
                    if str(UUID(source_id))!=str(stored['id']):
                        raise ValueError('identity')
                except (ValueError,TypeError,KeyError,ArithmeticError):
                    raise HTTPException(409,'原始费率身份无法完整核对') from None
                key=str(stored['id'])
                if key in source_ids and source_ids[key]!=source_id:
                    raise HTTPException(409,'旧费率原始编号有多个字面口径，不能猜测客户端身份')
                source_ids[key]=source_id
        for row in rows:
            if row['market'] is None:
                raise HTTPException(409,'旧费率市场未知，不能伪造默认市场或空方案')
            if row['legacy_original_base64'] is not None:
                try:
                    source=original(row['legacy_original_base64'])
                except (ValueError,TypeError,KeyError,ArithmeticError):
                    raise HTTPException(409,'已保存原费率证据不能完整解码') from None
                encoded=row['legacy_original_base64']
                authority='retained_legacy_original'
            else:
                try:
                    encoded=platform_projection(row,validate_rule,legacy_id=source_ids.get(str(row['id'])))
                except (ValueError,TypeError,KeyError,ArithmeticError):
                    raise HTTPException(409,'平台费率当前无法由旧端无损表达，请使用完整平台费率读取') from None
                source={'id':source_ids.get(str(row['id']),str(row['id']))}
                authority='platform_revision_projection_not_original'
            key='plan/'+source['id'] if row['revision']==row['current_revision'] and row['retired_at'] is None else 'history/'+source['id']+'/'+str(row['revision'])
            if key in fields:
                raise HTTPException(409,'多个平台费率对应同一旧端字段，不能覆盖原计划')
            fields[key]={'revision':row['revision'] if row['revision']==row['current_revision'] and row['retired_at'] is None else 1,'value':encoded}
            provenance[key]={'authority':authority,'originalBytesRetained':row['legacy_original_base64'] is not None,
                'market':row['market'],'planId':str(row['id']),'revision':row['revision'],'updatedAtAuthority':'original_source_date' if row['legacy_original_base64'] is not None else 'platform_commit_as_swift_reference_date'}
        from .fee_state_sync import overlay_fields
        await overlay_fields(conn,who.id,fields,provenance,rows)
        return {'version':1,'userId':who.id,'namespace':'fees','fields':fields,'fieldProvenance':provenance}
    async def list(self, who, account_id):
        async with self.db.connection() as conn, conn.transaction():
            from .account_signals import guard
            await guard(conn,who,'portfolio.read')
            await broker_account(conn, who.id, account_id)
            rows = await (
                await conn.execute(
                    "SELECT r.*,h.revision AS current_revision,h.retired_at FROM fee_plan_heads h JOIN fee_plan_revisions r ON r.owner_id=h.owner_id AND r.id=h.id WHERE h.owner_id=%s AND h.account_id=%s ORDER BY r.id,r.revision DESC LIMIT 1001",
                    (who.id, account_id),
                )
            ).fetchall()
            if len(rows) > 1000:
                raise HTTPException(409, "费率历史超出当前读取范围")
            return {
                "items": [
                    {
                        **r,
                        "id": str(r["id"]),
                        "effective_from": r["effective_from"].isoformat(),
                        "effective_through": r["effective_through"].isoformat() if r["effective_through"] is not None else None,
                        "created_at": r["created_at"].isoformat(),
                        "sourceAuthority":"retained_legacy_original" if r['legacy_original_base64'] is not None else 'platform_authored_no_legacy_original',
                        "originalBytesAvailable":r['legacy_original_base64'] is not None,
                    }
                    for r in rows
                ]
            }


async def fee_limit(db, who):
    """One owner budget across canonical/native routes and all fee mutations."""
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn,who,require_admin=False)
        result = await (
            await conn.execute(
                "INSERT INTO fee_rate_windows VALUES(%s,date_trunc('minute',clock_timestamp()),1) "
                "ON CONFLICT(owner_id,minute) DO UPDATE SET count=fee_rate_windows.count+1 RETURNING count",
                (who.id,),
            )
        ).fetchone()
        if result["count"] > 30:
            raise HTTPException(429, "核对过于频繁")
