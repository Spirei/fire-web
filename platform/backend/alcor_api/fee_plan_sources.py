"""Lossless legacy plan evidence mapped into the existing FeePlans revision authority."""

import base64
import json
import re
from decimal import Decimal, localcontext
from uuid import UUID

from fastapi import HTTPException

from .fee_rules import day


def decimal_value(value):
    if type(value) not in (str, int, Decimal):
        raise ValueError("exact_decimal_required")
    if isinstance(value, str) and not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value):
        raise ValueError("decimal_invalid")
    result = Decimal(value)
    if not result.is_finite() or not 0 <= result <= Decimal(1000000000000) or len(format(result, "f")) > 100:
        raise ValueError("decimal_range")
    return result


def original(raw):
    if not isinstance(raw, str) or not 1 <= len(raw) <= 87384 or not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", raw):
        raise ValueError("original_base64_invalid")
    decoded = base64.b64decode(raw + "=" * (-len(raw) % 4), validate=True)
    if len(decoded) > 65536:
        raise ValueError("original_too_large")
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError("duplicate_original_key")
            value[key] = item
        return value
    def constant(_):
        raise ValueError("nonfinite_original")
    value = json.loads(decoded.decode("utf-8"), parse_float=Decimal, object_pairs_hook=pairs, parse_constant=constant)
    if not isinstance(value, dict):
        raise TypeError("original_not_plan")
    return value


def normalize(raw, validate_rule):
    keys = {"requestId", "planId", "revision", "accountId", "providerId", "market", "effectiveFrom", "effectiveThrough", "components", "confirmed", "legacyOriginal"}
    if not isinstance(raw, dict) or set(raw)-keys or not keys-{"legacyOriginal"}<=set(raw) or raw["confirmed"] is not True:
        raise HTTPException(422, "须确认完整市场费率与来源")
    try:
        result = {**raw,'legacyOriginal':raw.get('legacyOriginal')}
        for key in ("requestId", "planId"):
            result[key] = str(UUID(raw[key]))
        if type(raw["revision"]) is not int or not 0 <= raw["revision"] < 9007199254740991:
            raise ValueError("revision_invalid")
        market, provider = raw["market"], raw["providerId"]
        if market not in ("us", "hk", "cn", "connect", "options") or not isinstance(provider, str) or not re.fullmatch(r"[a-z0-9-]{1,60}", provider):
            raise ValueError("market_provider_invalid")
        if (provider != "huatai" if market in ("cn", "connect") else provider in ("huatai", "eastmoney", "ths")):
            raise ValueError("market_provider_mismatch")
        day(raw["effectiveFrom"])
        if raw["effectiveThrough"] is not None and day(raw["effectiveThrough"]) < raw["effectiveFrom"]:
            raise ValueError("period_invalid")
        allowed = {"commission", "platform", "fundCommission"} if market == "cn" else {"commission", "platform"}
        if not isinstance(raw["components"], dict) or set(raw["components"]) - allowed:
            raise ValueError("component_invalid")
        result["components"] = {key: validate_rule(rule) for key, rule in raw["components"].items()}
        if result['legacyOriginal'] is None:
            return result  # Platform-authored authority; never manufacture imported original bytes.
        source = original(raw["legacyOriginal"])
        if set(source) - {"id", "revision", "accountID", "providerID", "market", "effectiveFrom", "effectiveThrough", "overrides", "updatedAt"}:
            raise ValueError("original_unknown_fields")
        if (str(UUID(source["id"])) != result["planId"] or type(source["revision"]) is not int or source["revision"] != raw["revision"]+1 or source["accountID"] != raw["accountId"] or source["providerID"] != provider or source["market"] != market or source["effectiveFrom"] != raw["effectiveFrom"] or source.get("effectiveThrough") != raw["effectiveThrough"]):
            raise ValueError("original_identity_or_version_mismatch")
        if not isinstance(source["overrides"], dict) or {key: validate_rule(rule) for key, rule in source["overrides"].items()} != result["components"]:
            raise ValueError("original_rules_mismatch")
        if type(source["updatedAt"]) not in (Decimal, int) or not Decimal(source["updatedAt"]).is_finite():
            raise ValueError("original_date_missing")
        # updatedAt is a source-format date number, never a server commit or Unix time.
    except (ValueError, TypeError, KeyError, ArithmeticError, UnicodeError, RecursionError):
        raise HTTPException(422, "市场、费率或十进制原始证据不一致") from None
    return result


def platform_projection(row,validate_rule,*,legacy_id=None):
    """Exact old wire representation of a platform revision, explicitly not an imported original."""
    import re
    from datetime import UTC, datetime

    from .market_contract import canonical
    if row['market'] not in ('us','hk','cn','connect','options') or not re.fullmatch(r'ba-[a-f0-9]{24}',row['account_id']):
        raise ValueError('legacy_identity_not_representable')
    components={}
    def exact(value):
        if value is None:return None
        result=decimal_value(value)
        with localcontext() as context:
            context.prec=160
            reduced=result.normalize()
        if len(reduced.as_tuple().digits)>38 or not -128<=reduced.as_tuple().exponent<=127:
            raise ValueError('legacy_decimal_not_exactly_representable')
        return result
    for name,raw in row['components'].items():
        rule=validate_rule(raw)
        components[name]={
            'basis':rule['basis'],'rate':exact(rule.get('rate')),'minimum':exact(rule.get('minimum')),
            'maximum':exact(rule.get('maximum')),'maximumPercent':exact(rule.get('maximumPercent')),
            'minimumWins':rule.get('minimumWins',True),'side':rule.get('side','both'),
            'tiers':[{'from':exact(tier['from']),'rate':exact(tier['rate'])} for tier in rule.get('tiers',[])],
            'graduated':rule.get('graduated',True)}
    stamp=row['created_at'].astimezone(UTC)-datetime(2001,1,1,tzinfo=UTC)
    seconds=Decimal(stamp.days*86400+stamp.seconds)+Decimal(stamp.microseconds)/Decimal(1000000)
    body={'id':legacy_id or str(row['id']),'accountID':row['account_id'],'providerID':row['provider_id'],'market':row['market'],
          'effectiveFrom':row['effective_from'].isoformat(),'effectiveThrough':row['effective_through'].isoformat() if row['effective_through'] is not None else None,
          'overrides':components,'revision':row['revision'],'updatedAt':seconds}
    raw=canonical(body).encode()
    if len(raw)>65536:
        raise ValueError('legacy_projection_budget')
    return base64.b64encode(raw).decode('ascii')
