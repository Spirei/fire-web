"""Legacy Web icon-map selection; independent from App lookup's 50-key protocol."""

import json
import re
from importlib.resources import files

from .asset_lookup_contract import normalize, trim

_DIRECTORY = json.loads(files("alcor_api").joinpath("data/discovery-related-etfs.json").read_text())
RELATED_PRODUCTS = _DIRECTORY["products"]
RELATED = dict(_DIRECTORY["legacyUnderlyings"])
for underlying, products in RELATED_PRODUCTS.items():
    for product in products:
        RELATED.setdefault(product["code"], underlying)

SUFFIXES = ("", ".AM", ".N", ".OQ", ".PS", ".K")
LEVERAGED_NAME = re.compile(
    r"(?:[1-5](?:\.\d+)?\s*倍|[一二两三四五]倍)\s*(?:做多|做空|反向)"
    r"|(?:[1-5](?:\.\d+)?\s*[x×]|[1-5]00%)\s*(?:long|short|inverse|bull|bear)\b"
    r"|\b(?:bull|bear|long|short|inverse)\s*(?:[1-5](?:\.\d+)?\s*[x×]|[1-5]00%)\b",
    re.IGNORECASE,
)


def related_root(market, code):
    if market.strip().upper() != "US":
        return None
    code = normalize("US", code)
    root = RELATED.get(code)
    visited = {code}
    while root in RELATED:
        if root in visited:
            return None
        visited.add(root)
        root = RELATED[root]
    return root


def stock_needs_underlying_review(item):
    if item["type"] != "stock" or item["market"] != "US":
        return False
    name = item["name"]
    return "ETF" in name.upper() and bool(LEVERAGED_NAME.search(name)) and not related_root(item["market"], item["code"])


def stock_image_review(item):
    if item["type"] != "stock" or item["market"] != "US":
        return None
    root = related_root(item["market"], item["code"])
    if root:
        return None if item.get("imageUrl") or item.get("url") else {"state": "missing-artwork", "code": root}
    if stock_needs_underlying_review(item):
        return {"state": "unverified-underlying"}
    return None


def select_web_keys(kind, keys=None, market=None, code=None):
    if kind == "flag" and keys:
        return [
            value for item in keys.split(",")[:50] if re.fullmatch(r"[A-Z]{2}", value := trim(item).upper())
        ]
    if kind == "stock" and (keys or (market and code)):
        if keys:
            return [
                {"market": item[:offset], "code": item[offset + 1 :]}
                for item in keys.split(",")[:200]
                if (offset := item.find(":")) > 0
            ]
        return [{"market": market, "code": code}]
    return None


def stock_codes(market, code):
    value = trim(code).upper()
    if not value:
        return []
    result = [value]
    if trim(market).upper() == "HK" and re.fullmatch(r"[0-9]+", value):
        result = list(dict.fromkeys([value, value.zfill(5), value.lstrip("0") or "0"]))
    return result


def related_icons(mapping):
    result = dict(mapping)
    for etf in RELATED:
        main = related_root("US", etf)
        url = result.get("US:" + main)
        for suffix in SUFFIXES:
            key = "US:" + etf + suffix
            if url:
                result[key] = url
            else:
                result.pop(key, None)
    return result


def icon_rows(kind, mapping):
    result = []
    for key, url in mapping.items():
        market, code = key.split(":", 1) if kind == "stock" else ("", key)
        result.append(
            {
                "id": f"stock:{market}:{code}" if kind == "stock" else "flag:" + code,
                "type": kind,
                "market": market,
                "code": code,
                "name": code,
                "url": url,
                "urlDark": "",
                "marketCap": None,
                "price": None,
                "changePct": None,
                "source": "auto",
                "lastCheckedAt": "",
                "board": "",
                "updatedAt": "",
            }
        )
    return result
