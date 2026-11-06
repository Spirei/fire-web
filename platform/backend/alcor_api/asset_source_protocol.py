"""Bounded original asset-provider protocols. No catalogue or file-system authority."""

import html
import ipaddress
import json
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit

from .fx_provider_parser import unique

LIMIT = 8 * 1024 * 1024
ICON_LIMIT = 2 * 1024 * 1024
HOSTS = {
    "eastmoney": {"push2.eastmoney.com", "push2delay.eastmoney.com"},
    "companiesmarketcap": {"companiesmarketcap.com", "www.companiesmarketcap.com"},
    "coingecko": {"api.coingecko.com", "assets.coingecko.com", "coin-images.coingecko.com"},
    "tradingview": {"www.tradingview.com", "s3-symbol-logo.tradingview.com"},
    "webull": {"quotes-gw.webullfintech.com", "quotes-static.webullfintech.com"},
    "parqet": {"assets.parqet.com"},
}
EXCHANGES = {
    "US": ("NASDAQ", "NYSE", "AMEX", "OTC"),
    "HK": ("HKEX",),
    "CN": ("SSE", "SZSE", "BSE"),
    "JP": ("TSE",),
    "KR": ("KRX",),
}
THRESHOLDS = {"US": Decimal(10000000000), "HK": Decimal(15000000000), "CN": Decimal(15000000000)}
METALS = (("GOLD", "黄金"), ("SILVER", "白银"), ("PLAT", "铂金"), ("PALLAD", "钯金"))
COINS = {
    r["code"]: r["id"]
    for r in json.loads((Path(__file__).parent / "data/discovery-mainstream-crypto.json").read_text())
}


def decimal(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
        if not number.is_finite() or abs(number) > Decimal("1e40"):
            return None
        return format(number, "f")
    except (InvalidOperation, ValueError, TypeError):
        return None


def document(raw):
    return json.loads(
        raw,
        object_pairs_hook=unique,
        parse_float=Decimal,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("asset_nonfinite")),
    )


def validate_target(target, owner_id=None, instance_id=None):
    if not isinstance(target, dict):
        raise TypeError("asset_target_invalid")
    try:
        if (
            not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", target["id"])
            or target["provider"] not in HOSTS
            or target["approvedAccess"] is not True
            or not target["ownerId"]
            or not target["instanceId"]
            or not target["licenseRevision"]
            or datetime.fromisoformat(target["expiresAt"]) <= datetime.now(UTC)
        ):
            raise ValueError("asset_target_not_approved")
        if (
            owner_id is not None
            and target["ownerId"] != owner_id
            or instance_id is not None
            and str(target["instanceId"]) != str(instance_id)
        ):
            raise ValueError("asset_target_identity")
        if (
            not isinstance(target["purposes"], list)
            or not target["purposes"]
            or not set(target["purposes"]) <= {"asset.search", "asset.list", "asset.icon", "asset.delisting"}
        ):
            raise ValueError("asset_target_purpose")
        if (
            not isinstance(target["addresses"], dict)
            or not target["addresses"]
            or set(target["addresses"]) - HOSTS[target["provider"]]
        ):
            raise ValueError("asset_target_hosts")
        for pins in target["addresses"].values():
            if (
                not isinstance(pins, list)
                or not 1 <= len(pins) <= 32
                or any(
                    not ipaddress.ip_address(ip).is_global or ipaddress.ip_address(ip).is_multicast
                    for ip in pins
                )
            ):
                raise ValueError("asset_target_pins")
        ua = target.get("userAgent", "AlcorAssetSources/1")
        if not isinstance(ua, str) or len(ua) > 512 or any(ord(c) < 32 or ord(c) > 126 for c in ua):
            raise ValueError("asset_user_agent")
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError("asset_target_invalid") from exc
    return target


@dataclass(frozen=True)
class Request:
    url: str
    provider: str
    purpose: str
    representation: str
    context: dict

    def as_dict(self):
        return asdict(self)


def validate_request(target, request):
    validate_target(target)
    parsed = urlsplit(request.url)
    if (
        request.provider != target["provider"]
        or request.purpose not in target["purposes"]
        or parsed.scheme != "https"
        or parsed.port not in (None, 443)
        or parsed.username
        or parsed.password
        or parsed.fragment
        or parsed.hostname not in target["addresses"]
        or parsed.hostname not in HOSTS[request.provider]
        or ".." in parsed.path.split("/")
    ):
        raise ValueError("asset_request_not_installed")
    host = parsed.hostname
    path = parsed.path
    if request.representation == "image_http_response_body":
        allowed = (
            request.provider == "tradingview"
            and host == "s3-symbol-logo.tradingview.com"
            and re.fullmatch(r"/[A-Za-z0-9_/%.-]+--big\.svg", path)
            or request.provider == "webull"
            and host == "quotes-static.webullfintech.com"
            and re.fullmatch(r"/ticker-icon/\d+\.png", path)
            or request.provider == "parqet"
            and host == "assets.parqet.com"
            and re.fullmatch(r"/logos/symbol/[A-Za-z0-9._%-]+", path)
            or request.provider == "coingecko"
            and host in {"assets.coingecko.com", "coin-images.coingecko.com"}
            and path.startswith("/coins/images/")
            or request.provider == "companiesmarketcap"
            and path.startswith("/img/company-logos/")
        )
        if not allowed or parsed.query and request.provider not in {"coingecko", "companiesmarketcap"}:
            raise ValueError("asset_image_path_invalid")
    else:
        allowed = (
            request.provider == "eastmoney"
            and path in {"/api/qt/clist/get", "/api/qt/stock/get"}
            or request.provider == "coingecko"
            and host == "api.coingecko.com"
            and path == "/api/v3/search"
            or request.provider == "companiesmarketcap"
            and path
            in {
                "/japan/largest-companies-in-japan-by-market-cap/",
                "/south-korea/largest-companies-in-south-korea-by-market-cap/",
            }
            or request.provider == "webull"
            and host == "quotes-gw.webullfintech.com"
            and path == "/api/search/pc/tickers"
            or request.provider == "tradingview"
            and host == "www.tradingview.com"
            and re.fullmatch(r"/symbols/[A-Z]+-[A-Za-z0-9._%-]+/", path)
        )
        if not allowed:
            raise ValueError("asset_protocol_path_invalid")
    return request


def normalized(market, code):
    if (
        market not in EXCHANGES
        or not isinstance(code, str)
        or not re.fullmatch(r"[A-Za-z0-9._-]{1,24}", code)
    ):
        raise ValueError("asset_security_invalid")
    code = code.upper()
    return code.zfill(5) if market == "HK" else code


def image_request(target, url, context):
    request = Request(url, target["provider"], "asset.icon", "image_http_response_body", dict(context))
    return validate_request(target, request)


def plan(target, action, selection=None, options=None, cursor=None):
    validate_target(target)
    selection = selection or {}
    options = options or {}
    provider = target["provider"]
    market = selection.get("market")
    ctx = {"action": action, **selection}
    page = cursor or 1
    if type(page) is not int or page < 1:
        raise ValueError("asset_cursor_invalid")
    if action == "search" and provider == "coingecko":
        q = selection.get("q", "")
        if not isinstance(q, str) or not 1 <= len(q.encode("utf-16-le")) // 2 <= 50:
            raise ValueError("asset_search_query_invalid")
        url = "https://api.coingecko.com/api/v3/search?" + urlencode({"query": q})
        purpose = "asset.search"
        representation = "coingecko_search_json"
    elif action in {"sync", "backfill", "list"} and provider == "eastmoney" and market in THRESHOLDS:
        if page > 30:
            raise ValueError("asset_list_page_budget")
        # Preserve the source asset-list universe, not the broader F17 ranking universe.
        filters = {
            "US": "m:105,m:106,m:107",
            "HK": "m:128+t:3,m:128+t:4,m:128+t:1,m:128+t:8",
            "CN": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
        }
        host = options.get("host", "push2delay.eastmoney.com")
        if host not in HOSTS[provider]:
            raise ValueError("asset_eastmoney_host")
        url = (
            "https://"
            + host
            + "/api/qt/clist/get?"
            + urlencode(
                {
                    "pn": page,
                    "pz": 100,
                    "po": 1,
                    "np": 1,
                    "fltt": 2,
                    "invt": 2,
                    "fid": "f20",
                    "fs": filters[market],
                    "fields": "f12,f13,f14,f2,f3,f20",
                }
            )
        )
        purpose = "asset.list"
        representation = "eastmoney_list_json"
        ctx.update(page=page, limit=100, maxPages=30, threshold=str(THRESHOLDS[market]))
    elif action in {"sync", "list"} and provider == "companiesmarketcap" and market in {"JP", "KR"}:
        if page > 6:
            raise ValueError("asset_list_page_budget")
        path = (
            "/japan/largest-companies-in-japan-by-market-cap/"
            if market == "JP"
            else "/south-korea/largest-companies-in-south-korea-by-market-cap/"
        )
        url = "https://companiesmarketcap.com" + path + "?" + urlencode({"page": page})
        purpose = "asset.list"
        representation = "cmc_list_html"
        ctx.update(page=page, limit=300, maxPages=6)
    elif action in {"check-delisted", "checkdelisted"} and provider == "eastmoney":
        code = normalized(market, selection.get("code"))
        secid = (
            "105." + code
            if market == "US"
            else "116." + code.zfill(5)
            if market == "HK"
            else ("1." if code.startswith("6") else "0.") + code
            if market == "CN"
            else None
        )
        if secid is None:
            raise ValueError("asset_delisting_market")
        url = "https://push2.eastmoney.com/api/qt/stock/get?" + urlencode(
            {"secid": secid, "fields": "f57,f58"}
        )
        purpose = "asset.delisting"
        representation = "eastmoney_security_json"
        ctx["code"] = code
    elif action in {"icon", "add", "add-by-search"}:
        purpose = "asset.icon"
        if provider == "companiesmarketcap" and selection.get("type") == "metal":
            matches = [
                item
                for item in metal_candidates(str(selection.get("code", "")))
                if item["code"] == selection.get("code", "").upper()
            ]
            if len(matches) != 1:
                raise ValueError("asset_metal_code_invalid")
            return image_request(target, matches[0]["iconUrl"], ctx)
        ctx["stage"] = options.get("stage", "image" if options.get("url") else provider)
        if ctx["stage"] == "image":
            return image_request(target, options["url"], ctx)
        code = normalized(market, selection.get("code"))
        ctx["code"] = code
        if provider == "tradingview":
            exchange = options.get("exchange", EXCHANGES[market][0])
            if exchange not in EXCHANGES[market]:
                raise ValueError("asset_exchange_invalid")
            symbol = re.sub(r"\.(OQ|N|AM|PS|K|HK|SS|SZ|T|KS|KQ)$", "", code)
            url = f"https://www.tradingview.com/symbols/{exchange}-{quote(symbol, safe='')}/"
            representation = "tradingview_symbol_html"
            ctx["exchange"] = exchange
        elif provider == "webull" and market in {"US", "HK", "CN"}:
            keyword = options.get("keyword", code)
            if not isinstance(keyword, str) or len(keyword) > 120:
                raise ValueError("asset_webull_keyword")
            url = "https://quotes-gw.webullfintech.com/api/search/pc/tickers?" + urlencode(
                {
                    "keyword": keyword,
                    "regionIds": {"US": 6, "HK": 2, "CN": 1}[market],
                    "pageIndex": 1,
                    "pageSize": 20,
                }
            )
            representation = "webull_search_json"
        elif provider == "parqet":
            return image_request(
                target, "https://assets.parqet.com/logos/symbol/" + quote(code, safe=""), ctx
            )
        else:
            raise ValueError("asset_icon_protocol_not_installed")
    else:
        raise ValueError("asset_action_protocol_not_installed")
    return validate_request(target, Request(url, provider, purpose, representation, ctx))


def metal_candidates(q):
    if not isinstance(q, str):
        return []
    q = q.strip().lower()
    return [
        {
            "type": "metal",
            "code": code,
            "name": name,
            "market": "ASSET",
            "iconUrl": f"https://companiesmarketcap.com/img/company-logos/64/{code}.XM.png",
        }
        for code, name in METALS
        if q and (q in code.lower() or q in name)
    ]


def board(market, code, exchange=None):
    if market == "US":
        return {106: "纽交所", 107: "美交所", 105: "纳斯达克"}.get(exchange)
    if market == "HK":
        return "创业板" if code.startswith("08") else "主板"
    if market == "CN":
        if code.startswith(("688", "689")):
            return "科创板"
        if code.startswith(("300", "301", "302")):
            return "创业板"
        if code.startswith(("8", "4", "920")):
            return "北交所"
        return "沪主板" if code.startswith("6") else "深主板"
    return None


def parse(raw, request):
    if (
        not isinstance(raw, bytes)
        or not raw
        or len(raw) > (ICON_LIMIT if request.representation == "image_http_response_body" else LIMIT)
    ):
        raise ValueError("asset_response_budget")
    ctx = request.context
    kind = request.representation
    items = []
    icons = []
    next_cursor = None
    coverage = {"scope": "provider_observed_page", "wholeMarketKnown": False}
    missing = None
    if kind == "image_http_response_body":
        # Immutable byte validation/normalization belongs to SystemAssets, not a parallel image authority.
        return {
            "raw": raw,
            "items": [],
            "iconRequests": [],
            "coverage": coverage,
            "imageBytes": raw,
            "sourceUrl": request.url,
        }
    if kind == "coingecko_search_json":
        rows = document(raw).get("coins")
        if not isinstance(rows, list) or len(rows) > 10000:
            raise ValueError("asset_crypto_search_shape")
        for row in rows:
            if not isinstance(row, dict):
                continue
            code = str(row.get("symbol", "")).upper()
            if code not in COINS or row.get("id") != COINS[code]:
                continue
            name = row.get("name")
            url = row.get("thumb")
            if not isinstance(name, str) or not name.strip():
                continue
            items.append(
                {
                    "type": "crypto",
                    "code": code,
                    "name": name.strip(),
                    "market": "ASSET",
                    "iconUrl": url.replace("/thumb/", "/large/") if isinstance(url, str) else None,
                    "providerId": row["id"],
                }
            )
            if len(items) == 8:
                break
        coverage.update(sourceItemCount=len(rows), selectionLimit=8, sourceFiltered=True)
    elif kind == "eastmoney_list_json":
        data = document(raw).get("data")
        rows = data.get("diff") if isinstance(data, dict) else None
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError("asset_eastmoney_page_shape")
        total = data.get("total")
        threshold = Decimal(ctx["threshold"])
        ordered = []
        unknown = 0
        for row in rows:
            code = normalized(ctx["market"], row.get("f12"))
            name = row.get("f14")
            cap = decimal(row.get("f20"))
            if not isinstance(name, str) or not name.strip():
                raise ValueError("asset_source_name_missing")
            if cap is None or Decimal(cap) <= 0:
                unknown += 1
                continue
            ordered.append(Decimal(cap))
            if Decimal(cap) < threshold:
                continue
            items.append(
                {
                    "type": "stock",
                    "market": ctx["market"],
                    "code": code,
                    "name": name.strip(),
                    "marketCap": cap,
                    "marketCapCurrency": {"US": "USD", "HK": "HKD", "CN": "CNY"}[ctx["market"]],
                    "price": decimal(row.get("f2")),
                    "changePct": decimal(row.get("f3")),
                    "board": board(ctx["market"], code, row.get("f13")),
                    "source": "auto",
                }
            )
        if any(ordered[i] > ordered[i - 1] for i in range(1, len(ordered))):
            raise ValueError("asset_cap_order_invalid")
        threshold_reached = bool(ordered and ordered[-1] < threshold)
        total_known = type(total) is int and total >= 0
        end = threshold_reached or len(rows) < 100 or total_known and ctx["page"] * 100 >= total
        if not end and ctx["page"] < 30:
            next_cursor = ctx["page"] + 1
        coverage.update(
            sourceItemCount=len(rows),
            providerTotal=total if total_known else None,
            threshold=ctx["threshold"],
            thresholdReached=threshold_reached,
            providerEndObserved=end,
            partial=unknown > 0 or not end and next_cursor is None,
            unknownMarketCapRows=unknown,
            pageBudget=30,
        )
    elif kind == "cmc_list_html":
        text = raw.decode("utf-8")
        rows = re.findall(r"<tr[^>]*>[\s\S]*?</tr>", text)
        if not rows or "<table" not in text:
            raise ValueError("asset_cmc_table_missing")
        for row in rows:
            name = re.search(r'company-name">([^<]*)<', row)
            symbol = re.search(r'company-code"><span class="rank d-none"></span>([^<]*)<', row)
            if not name or not symbol:
                continue
            code = normalized(ctx["market"], html.unescape(symbol[1]).strip())
            cap = re.search(r'class="td-right" data-sort="(\d+)"><span class="currency-symbol-left">', row)
            price = re.search(r'data-sort="\d+">\$([\d,.]+)</td>', row)
            pct = re.search(r"([+-]?[\d.]+)%</span>", row)
            items.append(
                {
                    "type": "stock",
                    "market": ctx["market"],
                    "code": code,
                    "name": html.unescape(name[1]).strip(),
                    "marketCap": decimal(cap[1]) if cap else None,
                    "marketCapCurrency": "USD",
                    "price": decimal(price[1].replace(",", "")) if price else None,
                    "priceCurrency": "USD",
                    "changePct": decimal(pct[1]) if pct else None,
                    "board": None,
                    "source": "auto",
                }
            )
        if items and ctx["page"] < 6:
            next_cursor = ctx["page"] + 1
        coverage.update(
            sourceItemCount=len(items),
            selectionLimit=300,
            providerEndObserved=not items,
            partial=bool(items) and next_cursor is None,
            pageBudget=6,
        )
    elif kind == "eastmoney_security_json":
        value = document(raw)
        if not isinstance(value, dict) or "data" not in value or value.get("rc") not in (None, 0):
            raise ValueError("asset_delisting_response_invalid")
        data = value["data"]
        code = ctx["code"]
        absent = data is None
        if data is not None and (
            not isinstance(data, dict)
            or str(data.get("f57", "")).upper().lstrip("0") != code.lstrip("0")
            or not isinstance(data.get("f58"), str)
            or not data["f58"].strip()
        ):
            raise ValueError("asset_delisting_identity_unknown")
        missing = {
            "market": ctx["market"],
            "code": code,
            "providerResponseMissing": absent,
            "securityDelistedKnown": False,
            "authority": "provider_security_lookup_not_exchange_delisting_notice",
            "requiresIndependentSecondObservation": True,
        }
    elif kind == "tradingview_symbol_html":
        text = raw.decode("utf-8")
        logo = re.search(r"https://s3-symbol-logo\.tradingview\.com/[A-Za-z0-9_/%.-]+--big\.svg", text)
        if logo:
            icons.append(Request(logo[0], "tradingview", "asset.icon", "image_http_response_body", ctx))
        coverage.update(iconObserved=bool(logo), symbolPage=request.url)
    elif kind == "webull_search_json":
        rows = document(raw).get("data")
        if not isinstance(rows, list) or len(rows) > 200:
            raise ValueError("asset_webull_response_shape")
        code = ctx["code"]
        same = lambda value: isinstance(value, str) and value.upper().lstrip("0") == code.lstrip("0")
        hit = next(
            (r for r in rows if isinstance(r, dict) and (same(r.get("symbol")) or same(r.get("disSymbol")))),
            None,
        )
        if hit and type(hit.get("tickerId")) is int and hit["tickerId"] > 0:
            icons.append(
                Request(
                    f"https://quotes-static.webullfintech.com/ticker-icon/{hit['tickerId']}.png",
                    "webull",
                    "asset.icon",
                    "image_http_response_body",
                    ctx,
                )
            )
        coverage.update(exactSecurityMatch=hit is not None, providerFallbackFirstStockUsed=False)
    else:
        raise ValueError("asset_parser_not_installed")
    return {
        "items": items,
        "candidates": items if kind == "coingecko_search_json" else [],
        "iconRequests": icons,
        "nextCursor": next_cursor,
        "coverage": coverage,
        "missingEvidence": missing,
    }
