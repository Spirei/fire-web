"""Latest quote DTOs over immutable owner/license-scoped PG facts. No source IO."""

import json
import math
import re
from datetime import datetime
from decimal import localcontext
from uuid import UUID

from fastapi import HTTPException

from .card_preferences import JS_WHITESPACE
from .market_authority import query_from
from .market_contract import CURRENCIES, code, number
from .market_snapshot_metrics import SnapshotMetricMismatch, with_snapshot_metrics
from .native_app_auth import CLIENT
from .security import lock_read_identity


def items_from(body):
    raw = body.get("items") if isinstance(body, dict) else None
    if not isinstance(raw, list) or not raw:
        return []
    if len(raw) > 100:
        raise HTTPException(400, "单次最多查询 100 只")
    result = []
    for item in raw:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("id"), str)
            or len(item["id"].encode("utf-16-le", errors="surrogatepass")) // 2 > 100
            or not isinstance(item.get("code"), str)
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", item["code"].strip(JS_WHITESPACE))
        ):
            continue
        try:
            item["id"].encode("utf-8")
        except UnicodeError:
            continue
        market = item.get("market")
        if not isinstance(market, str):
            market = "OTHER"
        market = market.strip(JS_WHITESPACE) or "OTHER"
        result.append({"id": item["id"], "market": market, "code": item["code"].strip(JS_WHITESPACE)})
    if not result:
        raise HTTPException(400, "没有有效的股票代码")
    return result


def observed(value, *, positive=False):
    result = number(value, positive=positive)
    numeric = float(result)
    if not math.isfinite(numeric):
        raise ValueError("legacy_number_outside_range")
    return result, numeric


def signed(value):
    decimal = number(value, signed=True)
    numeric = float(decimal)
    if not math.isfinite(numeric):
        raise ValueError("invalid_signed_metric")
    return numeric


def project(row, policy, market, now, *, include_market_cap=True):
    value = row["contents"]
    if not isinstance(value, dict):
        return None, "invalid_source_fact"
    try:
        price, price_float = observed(value.get("price"), positive=True)
        at = datetime.fromisoformat(value["at"])
        if at.tzinfo is None or at != row["source_time"] or value.get("currency") != CURRENCIES[market]:
            raise ValueError("source_time_or_currency_mismatch")
        if (
            not policy.source_version
            or value.get("source") != policy.source
            or value.get("sourceVersion") != policy.source_version
        ):
            raise ValueError("source_protocol_mismatch")
        age = (now - at).total_seconds()
        if age < -5:
            raise ValueError("future_source_time")
    except (KeyError, ValueError, TypeError, OverflowError):
        return None, "invalid_source_fact"
    session = value.get("session")
    if session not in ("REGULAR", "PRE", "AFTER", "OVERNIGHT"):
        session = "UNKNOWN"
    cached = value.get("cached") if type(value.get("cached")) is bool else None
    legacy_cache_assumption = policy.source == "futu" and "providerCacheState" not in value
    if legacy_cache_assumption:
        cached = None
        session = "UNKNOWN"
    stale = age > 90 or session == "UNKNOWN" or cached is not False
    result = {
        "name": value.get("name") if isinstance(value.get("name"), str) else "",
        "price": price_float,
        "time": at.isoformat(),
        "source": policy.source,
        "session": session,
        "displayStale": stale,
        "cached": cached,
        "providerCacheState": value.get("providerCacheState", "unknown" if cached is None else "source_declared"),
    }
    if legacy_cache_assumption:
        result["legacyRegisteredCached"] = value.get("cached")
    for field in ("requestedSession", "priceField", "sourceTimestampAuthority", "sessionWindowAuthority",
                  "priceNumberAuthority", "snapshotObservedAt", "changeBasis", "baselineField", "baselineAt", "baselineState", "underlyingSymbol", "securityStatus", "rangeBasis", "amountRolling24hCurrency", "priceBasis", "sourceSymbol"):
        if isinstance(value.get(field), str) and len(value[field]) <= 256:
            result[field] = value[field]
    for field in ("otc", "suspended", "individualSessionTradeTimeKnown", "indexValid", "warrantValid", "optionValid"):
        result[field] = value.get(field) if type(value.get(field)) is bool else None
    for field in ("dayStatsExact", "context"):
        if isinstance(value.get(field), dict):
            result[field] = value[field]
    regular = value.get("regularSnapshotMetrics")
    if isinstance(regular, dict):
        result["regularSnapshotMetrics"] = {}
        for field in ("turnover", "amplitude", "volumeRatio", "averagePrice"):
            if regular.get(field) is not None:
                try:
                    _, metric = observed(regular[field], positive=field == "averagePrice")
                    result["regularSnapshotMetrics"][field] = metric
                except (ValueError, TypeError, OverflowError):
                    continue
    for field in (
        "open",
        "high",
        "low",
        "prevClose",
        "volume",
        "amount",
        "marketCap",
        "turnover",
        "amplitude",
        "volumeRatio",
        "averagePrice",
        "weekHigh",
        "weekLow",
        "totalShares",
        "floatShares",
        "circularMarketVal",
        "dividendYieldTtm",
        "dividendTtm",
        "fundUnits",
        "fundAssetsUnderManagement",
        "fundNetAssetValue",
        "regularPrevClose", "lotSize", "priceSpread", "amountRolling24h",
    ):
        if field.startswith('fund') and value.get('fundValid') is not True:
            continue
        if value.get(field) is None:
            continue
        try:
            _, metric = observed(
                value[field],
                positive=field
                in (
                    "open",
                    "high",
                    "low",
                    "prevClose",
                    "marketCap",
                    "averagePrice",
                    "weekHigh",
                    "weekLow",
                    "totalShares",
                    "floatShares",
                    "circularMarketVal",
                    "fundUnits",
                    "fundAssetsUnderManagement",
                    "fundNetAssetValue", "regularPrevClose", "lotSize", "priceSpread",
                ),
            )
            result[field] = metric
        except (ValueError, TypeError, OverflowError):
            continue
    for field in ("change", "changePct", "pe", "peTtm", "peRatio", "pb", "earningPerShare", "providerSessionChange", "providerSessionChangePct"):
        if value.get(field) is None:
            continue
        try:
            metric = signed(value[field])
            if field not in ("pe", "peTtm", "peRatio", "pb") or metric != 0:
                result[field] = metric
        except (ValueError, TypeError, OverflowError):
            continue
    if row.get("snapshot_metrics_unavailable"):
        result["snapshotMetrics"] = {"state":"unavailable","reason":row["snapshot_metrics_unavailable"],"sourcePageId":str(row["page_id"])}
    if type(value.get("snapshotMetricsVersion")) is int and value["snapshotMetricsVersion"] in (1, 2):
        result["snapshotMetrics"] = {
            "state": "recovered_from_original_sdk_page"
            if row.get("snapshot_metrics_recovered")
            else "normalized",
            "sourcePageId": str(row["page_id"]),
        }
    if type(value.get("equityValid")) is bool:
        result["equityValid"] = value["equityValid"]
    if value.get("peBasis") in ("pe_ttm_ratio", "pe_ratio"):
        result["peBasis"] = value["peBasis"]
    if value.get("earningPerSharePeriod") == "unspecified" and "earningPerShare" in result:
        result["earningPerSharePeriod"] = "unspecified"
    if "weekHigh" in result and "weekLow" in result and result["weekHigh"] < result["weekLow"]:
        result.pop("weekHigh")
        result.pop("weekLow")
    equity = value.get("equityValid") is True
    if type(value.get('fundValid')) is bool:
        result['fundValid'] = value['fundValid']
    if value.get('fundValid') is True:
        cap = None
        if include_market_cap and value.get('fundUnits') is not None:
            try:
                units, _ = observed(value['fundUnits'], positive=True)
                with localcontext() as decimal_context:
                    decimal_context.prec = 80
                    cap = price * units
                _, legacy_cap = observed(str(cap), positive=True)
                if result.get('marketCap') is None:
                    result['marketCap'] = legacy_cap
                    result['marketCapBasis'] = 'observed_fund_units_times_observed_quote'
            except (ValueError, TypeError, OverflowError):
                cap = None
        result['fundMetrics'] = {
            'units': value.get('fundUnits'), 'assetsUnderManagement': value.get('fundAssetsUnderManagement'),
            'netAssetValue': value.get('fundNetAssetValue'), 'calculatedMarketCap': str(cap) if cap is not None else None,
            'price': str(price), 'currency': CURRENCIES[market], 'observedAt': at.isoformat(),
            'sourcePageId': str(row['page_id']), 'source': policy.source,
            'aumIsMarketCapitalization': False,
        }
    result["detailMetrics"] = {
        "currency": CURRENCIES[market],
        "time": value.get("snapshotObservedAt") or at.isoformat(),
        "source": policy.source,
        "turnoverRate": result.get("turnover"),
        "peTtm": result.get("peTtm") if equity else None,
        "pe": result.get("peRatio") if equity else None,
        "marketCap": result.get("marketCap") if equity or value.get('fundValid') is True else None,
        "dividendYieldTtm": result.get("dividendYieldTtm") if equity else None,
    }
    exact={}
    for field in ("open","high","low","prevClose","change","changePct","volume","amount","amountRolling24h"):
        if field in result and value.get(field) is not None:
            try:
                exact[field]=str(number(value[field],signed=field in ("change","changePct")))
            except (ValueError,TypeError):
                continue
    result.setdefault("dayStatsExact",exact)
    if (
        "high" in result
        and "low" in result
        and (
            result["high"] < result["low"]
            or "open" in result
            and not result["low"] <= result["open"] <= result["high"]
        )
    ):
        for field in ("open", "high", "low"):
            result.pop(field, None)
    if "prevClose" in result:
        with localcontext() as context:
            context.prec = 100
            previous = number(value["prevClose"], positive=True)
            result.setdefault("change", float(price - previous))
            result.setdefault("changePct", float((price / previous - 1) * 100))
    return result, "stale" if stale else "observed"


class BatchQuotes:
    def __init__(self, authority):
        self.authority, self.db = authority, authority.db

    async def read(self, who, items, source_revision=None, *, session=None, include_market_cap=True, strict_sources=False, source_preference=None, instrument=None, preferred_session=None, legacy_instruments=False):
        if instrument not in (None, "equity", "index", "asset"):
            raise HTTPException(400, "证券类型无效")
        if session not in (None, "REGULAR", "PRE", "AFTER", "OVERNIGHT"):
            raise HTTPException(400, "最新报价时段无效")
        if source_revision is not None:
            try:
                source_revision = UUID(source_revision)
            except (ValueError, TypeError, AttributeError):
                raise HTTPException(400, "行情来源版本无效") from None
        quotes, states = {}, {}
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await lock_read_identity(conn, who, require_admin=False)
            if getattr(who, "native_client", False):
                grant = await (
                    await conn.execute(
                        "SELECT client_id FROM identity_app_grants WHERE id=%s", (who.grant_id,)
                    )
                ).fetchone()
                if not grant or grant["client_id"] != CLIENT:
                    raise HTTPException(401, "客户端连接已变化")
            user = await (await conn.execute("SELECT role FROM users WHERE id=%s", (who.id,))).fetchone()
            if not user or user["role"] != who.role:
                raise HTTPException(403, "账号权限已变化")
            policies = {}
            unavailable_policies = set()

            async def policy(revision):
                if revision in unavailable_policies:
                    raise HTTPException(403, "行情来源的当前许可已变化，请撤下旧报价")
                if revision not in policies:
                    try:
                        _, policies[revision] = await self.authority.config(conn, who.id, revision)
                    except HTTPException:
                        unavailable_policies.add(revision)
                        raise HTTPException(403, "行情来源的当前许可已变化，请撤下旧报价") from None
                return policies[revision]

            if source_revision is not None:
                await policy(source_revision)
            if self.authority.clock and self.db.settings.environment != "test":
                raise HTTPException(503, "行情时钟不可用")
            now = (
                self.authority.clock()
                if self.authority.clock
                else (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
            )
            normalized = {}
            seen = {}
            ambiguous = set()
            for item in items:
                try:
                    symbol = (item["market"], code(item["market"], item["code"]))
                except ValueError:
                    if item["id"] in seen and seen[item["id"]] != (
                        "unsupported",
                        item["market"],
                        item["code"],
                    ):
                        ambiguous.add(item["id"])
                    seen[item["id"]] = ("unsupported", item["market"], item["code"])
                    states[item["id"]] = {"state": "unsupported_market_or_code"}
                    continue
                if item["id"] in seen and seen[item["id"]] != symbol:
                    ambiguous.add(item["id"])
                seen[item["id"]] = symbol
                normalized[item["id"]] = symbol
            for identifier in ambiguous:
                states[identifier] = {"state": "ambiguous_request_id"}
            resolved = {}
            snapshot_pages = {}
            for identifier, (market, symbol) in normalized.items():
                if identifier in ambiguous:
                    states[identifier] = {"state": "ambiguous_request_id"}
                    continue
                cache_key = (market, symbol)
                if cache_key not in resolved:
                    if source_revision is not None:
                        approved = await policy(source_revision)
                        if market not in approved.markets or "latest" not in approved.purposes:
                            raise HTTPException(403, "当前来源许可未覆盖所请求的行情")
                    query_instrument=instrument
                    if legacy_instruments and query_instrument is None:query_instrument='asset' if market=='ASSET' else 'equity'
                    streams = await (
                        await conn.execute(
                            "SELECT s.*,c.policy_id,t.status AS task_status,t.finished_at AS task_finished_at FROM market_streams s JOIN market_source_configs c ON c.owner_id=s.owner_id AND c.revision=s.source_revision LEFT JOIN tasks t ON t.id=s.current_task_id WHERE s.owner_id=%s AND s.query->>'kind'='latest' AND s.query->>'market'=%s AND s.query->>'code'=%s AND (%s::uuid IS NULL OR s.source_revision=%s) AND (%s::text IS NULL OR s.query->>'session'=%s) AND (%s::text IS NULL OR s.query->>'instrument'=%s) ORDER BY s.source_revision,s.id",
                            (who.id, market, symbol, source_revision, source_revision, session, session, query_instrument, query_instrument),
                        )
                    ).fetchall()
                    candidates = []
                    cooling_sources=set()
                    integrity_failure = False
                    sources = set()
                    instruments = set()
                    source_families = {}
                    source_instruments = {}
                    failed_sources = set()
                    retained_source = False
                    retained_policy_ids = set()
                    current_policy_ids = set()
                    for stream in streams:
                        try:
                            approved = await policy(stream["source_revision"])
                        except HTTPException:
                            if source_revision is not None:
                                raise
                            retained_source = True
                            retained_policy_ids.add(stream["policy_id"])
                            continue
                        if source_revision is None and source_preference in ("futu","tencent")and market!="ASSET"and approved.source!=source_preference:continue
                        if stream.get('task_status')=='failed' and stream.get('task_finished_at') and (now-stream['task_finished_at']).total_seconds()<60:
                            cooling_sources.add(stream['source_revision'])
                        query = query_from(stream["query"])
                        self.authority.validate_query(approved, query)
                        sources.add(stream["source_revision"])
                        source_families[stream["source_revision"]] = approved.source
                        source_instruments.setdefault(stream["source_revision"], set()).add(query.instrument)
                        current_policy_ids.add(approved.id)
                        instruments.add(query.instrument)
                        fact = await (
                            await conn.execute(
                                "SELECT * FROM market_facts WHERE owner_id=%s AND stream_id=%s AND source_revision=%s ORDER BY source_time DESC,sequence DESC LIMIT 1",
                                (who.id, stream["id"], stream["source_revision"]),
                            )
                        ).fetchone()
                        if fact:
                            try:
                                fact = await with_snapshot_metrics(
                                    conn, who, query, approved, fact, snapshot_pages
                                )
                            except SnapshotMetricMismatch:
                                integrity_failure = True
                                failed_sources.add(stream["source_revision"])
                                continue
                            dto, state = project(fact, approved, market, now, include_market_cap=include_market_cap)
                            if dto:
                                if market=='US' and preferred_session is not None:
                                    dto['expectedSession']=preferred_session
                                    dto['extendedUnavailable']=preferred_session!='REGULAR' and dto.get('session')!=preferred_session
                                candidates.append((fact, approved, dto, state))
                    # A new explicit authorization must remain usable after an
                    # identity/security change. Old stream rows are retained as
                    # evidence, but neither their quotes nor their failed grant
                    # may replace/block the currently authorized source.
                    if strict_sources and retained_source and not retained_policy_ids <= current_policy_ids:
                        raise HTTPException(403, "行情来源的当前许可已变化，请撤下旧报价")
                    if preferred_session is not None and market == 'US':
                        extended = [c for c in candidates if c[0]['contents'].get('requestedSession') == preferred_session and c[2]['session'] == preferred_session]
                        regular = [c for c in candidates if c[0]['contents'].get('requestedSession', 'REGULAR') == 'REGULAR']
                        # Never let a retained PRE/AFTER/night observation from a
                        # previous date replace this cycle's regular observation.
                        newest_regular = max((c[0]['source_time'] for c in regular), default=None)
                        extended = [c for c in extended if newest_regular is None or c[0]['source_time'] >= newest_regular]
                        candidates = extended or regular
                        chosen = {c[0]['source_revision'] for c in candidates}
                        sources &= chosen
                        instruments = set().union(*(source_instruments[r] for r in sources)) if sources else set()
                    if source_revision is None and source_preference == "auto" and market != "ASSET":
                        usable=[c for c in candidates if c[0]['source_revision'] not in cooling_sources]
                        if usable:candidates=usable
                        order = getattr(self.db.settings, "_legacy_quote_order", None) or ["futu", "tencent", "eastmoney", "yahoo"]
                        for provider in order:
                            prioritized = [c for c in candidates if c[1].source == provider]
                            if prioritized:
                                candidates = prioritized
                                sources = {revision for revision in sources if source_families[revision] == provider}
                                instruments = set().union(*(source_instruments[revision] for revision in sources))
                                integrity_failure = bool(failed_sources & sources)
                                break
                    if integrity_failure:
                        resolved[cache_key] = (None, {"state": "unverified_source_page"})
                    elif len(sources) > 1:
                        resolved[cache_key] = (None, {"state": "ambiguous_source"})
                    elif len(instruments) > 1:
                        resolved[cache_key] = (None, {"state": "ambiguous_instrument"})
                    elif not candidates:
                        resolved[cache_key] = (None, {"state": "retained_source_unavailable" if retained_source else "missing"})
                    else:
                        latest = max(fact["source_time"] for fact, _, _, _ in candidates)
                        same = [item for item in candidates if item[0]["source_time"] == latest]
                        selected_session_facts = [item for item in same if item[2]["session"] in ("PRE", "AFTER", "OVERNIGHT")
                            and item[0]["contents"].get("requestedSession") == item[2]["session"]]
                        if session is None and selected_session_facts and all(item in selected_session_facts or item[2]["session"] == "UNKNOWN" for item in same):
                            # The very same SDK snapshot can retain last_price
                            # beside a separately observed extended price. Prefer
                            # only its explicitly selected, validated source field.
                            same = selected_session_facts
                        if (
                            len(
                                {
                                    json.dumps(
                                        {
                                            "dto": item[2],
                                            "observed": {
                                                key: item[0]["contents"].get(key)
                                                for key in (
                                                    "price",
                                                    "prevClose",
                                                    "open",
                                                    "high",
                                                    "low",
                                                    "volume",
                                                    "amount",
                                                    "change",
                                                    "changePct",
                                                    "marketCap",
                                                    "pe",
                                                    "turnover",
                                                )
                                            },
                                        },
                                        sort_keys=True,
                                        default=str,
                                    )
                                    for item in same
                                }
                            )
                            != 1
                        ):
                            resolved[cache_key] = (None, {"state": "ambiguous_session_fact"})
                        else:
                            fact, approved, dto, state = max(same, key=lambda item: item[0]["sequence"])
                            resolved[cache_key] = (
                                dto,
                                {
                                    "state": state,
                                    "sourceRevision": str(fact["source_revision"]),
                                    "licenseRevision": approved.license_revision,
                                    "factId": str(fact["id"]),
                                    "factRevision": fact["sequence"],
                                    "sourceTime": fact["source_time"].isoformat(),
                                    "priceExact": str(number(fact["contents"]["price"], positive=True)),
                                },
                            )
                dto, state = resolved[cache_key]
                states[identifier] = state
                if dto:
                    quotes[identifier] = dto
        return {"quotes": quotes, "quoteStates": states}
