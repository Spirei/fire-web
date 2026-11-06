"""Captured exact lookup normalization; no symbol inference or source requests."""

import hashlib
import json
import re
from uuid import UUID

from fastapi import HTTPException

from .card_preferences import JS_WHITESPACE


def reject_constant(_):
    raise ValueError()


def trim(value):
    return value.strip(JS_WHITESPACE)


def normalize(market, code):
    value = trim(code).upper()
    if market == "US":
        return re.sub(r"\.(AM|N|OQ|PS|K)$", "", value)
    if market == "HK" and re.fullmatch(r"[0-9]+", value):
        return value.lstrip("0").zfill(5)
    if market == "CN" and re.fullmatch(r"[0-9]+", value):
        return value.zfill(6)
    if market == "JP":
        return re.sub(r"\.T$", "", value)
    if market == "KR":
        return re.sub(r"\.(KS|KQ)$", "", value)
    return value


def parse_lookup(raw):
    if not isinstance(raw, str) or len(raw.encode("utf-16-le", "surrogatepass")) // 2 > 10000:
        raise HTTPException(400, "素材查询参数无效，单次最多 50 项")
    try:
        data = json.loads(raw, parse_constant=reject_constant)
        if not isinstance(data, list) or len(data) > 50:
            raise ValueError()
        keys = {}
        for item in data:
            if (
                not isinstance(item, dict)
                or item.get("type") not in ("stock", "market", "crypto", "metal")
                or not isinstance(item.get("market"), str)
                or not isinstance(item.get("code"), str)
            ):
                raise ValueError()
            raw_market, code = trim(item["market"]), trim(item["code"])
            market = raw_market.upper()
            if (
                not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", code)
                or not re.fullmatch(r"[A-Za-z0-9_-]{0,16}", raw_market)
                or (item["type"] == "stock" and not market)
            ):
                raise ValueError()
            value = {
                "type": item["type"],
                "market": market,
                "code": normalize(market, code) if item["type"] == "stock" else code.upper(),
            }
            if not value["code"]:
                raise ValueError()
            keys[tuple(value.values())] = value
        return list(keys.values())
    except (ValueError, TypeError, RecursionError):
        raise HTTPException(400, "素材查询参数无效，单次最多 50 项") from None


def lookup_codes(key):
    market, code = key["market"], key["code"]
    if key["type"] == "stock" and market == "US":
        return [code] + [code + "." + suffix for suffix in ("AM", "N", "OQ", "PS", "K")]
    if key["type"] == "stock" and market == "HK" and re.fullmatch(r"[0-9]+", code):
        return list(dict.fromkeys([code, code.zfill(5), code.lstrip("0") or "0"]))
    if key["type"] == "stock" and market == "JP":
        return [code, code + ".T"]
    if key["type"] == "stock" and market == "KR":
        return [code, code + ".KS", code + ".KQ"]
    return [code]


def image_key(identifier, variant="light"):
    return hashlib.sha256((identifier + "\0" + variant).encode()).hexdigest()[:24]


def alias_path(value):
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"/uploads/asset/[A-Za-z0-9._%/-]{1,480}", value)
        or ".." in value
        or any(part.startswith(".") for part in value.split("/"))
    ):
        raise HTTPException(400, "公共素材别名无效")
    return value


def manifest(text, label):
    try:
        text_size = len(text.encode("utf-8")) if isinstance(text, str) else 60001
        if isinstance(label, str):
            label.encode("utf-8")
    except UnicodeError:
        raise HTTPException(400, "公开素材清单无效") from None
    if (
        not isinstance(text, str)
        or text_size > 60000
        or not isinstance(label, str)
        or not 1 <= len(trim(label)) <= 120
        or any(ord(char) < 32 for char in label)
    ):
        raise HTTPException(400, "公开素材清单无效")
    try:
        value = json.loads(text, parse_constant=reject_constant)
        if (
            not isinstance(value, dict)
            or set(value) != {"version", "publicMetadataConfirmed", "entries"}
            or value["version"] != 1
            or type(value["version"]) is not int
            or value["publicMetadataConfirmed"] is not True
            or not isinstance(value["entries"], list)
            or not 1 <= len(value["entries"]) <= 200
        ):
            raise ValueError()
        seen = set()
        entries = []
        for item in value["entries"]:
            allowed = {
                "id",
                "type",
                "market",
                "code",
                "name",
                "imageVersion",
                "darkImageVersion",
                "aliases",
                "darkAliases",
            }
            if (
                not isinstance(item, dict)
                or set(item) - allowed
                or not {"id", "type", "market", "code", "name"} <= set(item)
                or item["type"]
                not in ("stock", "market", "flag", "crypto", "metal", "broker", "group", "icon")
            ):
                raise ValueError()
            if any(not isinstance(item[k], str) for k in ("id", "market", "code", "name")):
                raise ValueError()
            item["name"].encode("utf-8")
            identifier = item["id"]
            if not re.fullmatch(r"[A-Za-z0-9:._-]{1,120}", identifier) or identifier in seen:
                raise ValueError()
            seen.add(identifier)
            market, code = trim(item["market"]).upper(), trim(item["code"]).upper()
            if (
                not re.fullmatch(r"[A-Z0-9_-]{0,16}", market)
                or not (item["type"] == "broker" and 1 <= len(code) <= 40 and not any(ord(c) < 32 for c in code)) and not re.fullmatch(
                    r"[A-Z0-9._-]{0,40}" if item["type"] in ("market", "group") else r"[A-Z0-9._-]{1,40}",
                    code,
                )
                or (item["type"] == "stock" and not market)
                or len(item["name"]) > 120
                or any(ord(c) < 32 for c in item["name"])
            ):
                raise ValueError()
            clean = {
                "id": identifier,
                "type": item["type"],
                "market": market,
                "code": code,
                "name": trim(item["name"]),
            }
            for field in ("imageVersion", "darkImageVersion"):
                raw = item.get(field)
                clean[field] = str(UUID(raw)) if raw else None
            for field in ("aliases", "darkAliases"):
                raw = item.get(field, [])
                if not isinstance(raw, list) or len(raw) > 10:
                    raise ValueError()
                clean[field] = list(dict.fromkeys(alias_path(path) for path in raw))
            entries.append(clean)
        return {
            "entries": entries,
            "sourceLabel": trim(label),
            "sha256": hashlib.sha256(text.encode()).hexdigest(),
        }
    except (ValueError, TypeError, AttributeError, UnicodeError, RecursionError):
        raise HTTPException(400, "公开素材清单无效") from None
