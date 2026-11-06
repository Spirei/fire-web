"""Strict price-alert protocol; notifications never authorize financial operations."""

import re
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

CHANNELS = ("app", "email", "telegram", "wechat", "feishu", "discord", "qq")
ACTIONS = frozenset(
    {"upsert", "delete", "state", "channel", "test", "read", "telegram_confirm", "telegram_disconnect"}
    | {
        f"{channel}_{action}"
        for channel in ("wechat", "feishu", "discord", "qq")
        for action in ("start", "confirm", "disconnect")
    }
)


def uuid(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value
    ):
        raise ValueError("uuid_required")
    return str(UUID(value))


def price(value):
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"\d{1,10}(?:\.\d{1,6})?", value)
        or Decimal(value) <= 0
    ):
        raise ValueError("six_decimal_positive_price_required")
    return Decimal(value)


def rule(raw, now):
    if (
        not isinstance(raw, dict)
        or raw.keys()
        - {
            "id",
            "name",
            "code",
            "market",
            "direction",
            "price",
            "extended",
            "frequency",
            "expiresAt",
            "sourceRevision",
        }
        or not {"id", "name", "code", "market", "direction", "price", "extended", "frequency"} <= raw.keys()
    ):
        raise ValueError("rule_fields_invalid")
    identifier = uuid(raw["id"])
    name, code, market = raw["name"], raw["code"], raw["market"]
    if (
        not isinstance(name, str)
        or not name.strip()
        or len(name.encode("utf-16-le")) // 2 > 80
        or re.search(r"[\x00-\x1f\x7f]", name)
    ):
        raise ValueError("rule_name_invalid")
    if market not in {"US", "HK", "CN"} or not isinstance(code, str):
        raise ValueError("security_invalid")
    code = code.strip().upper()
    if market == "US":
        code = re.sub(r"\.(OQ|N|AM|PS|K)$", "", code)
    elif market == "HK" and code.isdigit():
        code = code.lstrip("0").zfill(5)
    elif market == "CN" and code.isdigit():
        code = code.zfill(6)
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9.\-]{0,19}", code):
        raise ValueError("security_invalid")
    price(raw["price"])
    if (
        raw["direction"] not in {"above", "below"}
        or raw["frequency"] not in {"once", "daily"}
        or type(raw["extended"]) is not bool
    ):
        raise ValueError("rule_policy_invalid")
    if 'sourceRevision' in raw:
        uuid(raw['sourceRevision'])
    expiry = raw.get("expiresAt")
    if expiry is not None and (
        type(expiry) is not int
        or not int(now.timestamp() * 1000) < expiry <= int(now.timestamp() * 1000) + 3650 * 86400000
    ):
        raise ValueError("expiry_invalid")
    return {
        **raw,
        "id": identifier,
        "name": name.strip(),
        "code": code,
        "extended": market == "US" and raw["extended"],
        "expiresAt": expiry,
        **({'sourceRevision':uuid(raw['sourceRevision'])} if 'sourceRevision' in raw else {}),
    }


def millis(value):
    return int(value.astimezone(UTC).timestamp() * 1000)


def timestamp(value):
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError("source_time_invalid")
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError("source_timezone_required")
    return result.astimezone(UTC)


def visible(header):
    return CHANNELS if header == "messengers-v1" else CHANNELS[:4] if header == "wechat-v1" else CHANNELS[:3]
