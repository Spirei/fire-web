"""Legacy Web icon-map selection; independent from App lookup's 50-key protocol."""

import json
import re
from importlib.resources import files

from .asset_lookup_contract import trim

RELATED = json.loads(files("alcor_api").joinpath("data/asset_related_icons.json").read_text())
SUFFIXES = ("", ".AM", ".N", ".OQ", ".PS", ".K")


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
    for etf, main in RELATED.items():
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
