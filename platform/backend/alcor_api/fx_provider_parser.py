"""Exact source rates, declared precision and explicit outbound target validation."""

import json
import re
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from fractions import Fraction
from urllib.parse import urlsplit

CODE = re.compile(r"^[A-Z]{3}$")
NUMBER = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")


def code(value):
    return value.strip().upper() if isinstance(value, str) and CODE.fullmatch(value.strip().upper()) else None


def unique(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def numeric(value):
    if isinstance(value, bool) or not isinstance(value, (str, Decimal, int)):
        return None
    text = str(value).strip()
    if len(text) > 128 or not NUMBER.fullmatch(text):
        return None
    number = Decimal(text)
    if not number.is_finite() or number <= 0 or abs(number.adjusted()) > 64:
        return None
    return number


def parse(raw, declared_base=None):
    if len(raw) > 131072:
        raise ValueError("response_too_large")
    root = json.loads(
        raw,
        parse_float=Decimal,
        parse_int=Decimal,
        object_pairs_hook=unique,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non_finite")),
    )
    if not isinstance(root, dict) or root.get("success") is False or root.get("result") == "error":
        raise ValueError("provider_error")
    for payload in (root, root.get("data")):
        if (
            not isinstance(payload, dict)
            or payload.get("success") is False
            or payload.get("result") == "error"
        ):
            continue
        raw_base = next(
            (p[k] for p in (payload, root) for k in ("base", "base_code", "source") if p.get(k) is not None),
            None,
        )
        base = code(raw_base)
        if raw_base is not None and base is None:
            raise ValueError("invalid_base")
        if declared_base is not None and code(declared_base) != declared_base:
            raise ValueError("invalid_declared_base")
        if base and declared_base and base != declared_base:
            raise ValueError("base_conflict")
        base = base or declared_base
        for candidate in (
            payload.get("rates"),
            payload.get("conversion_rates"),
            payload.get("quotes"),
            payload,
        ):
            if not isinstance(candidate, dict):
                continue
            values = {}
            for key, value in candidate.items():
                key = key.strip().upper()
                if len(key) == 6 and key[:3] == base:
                    key = key[3:]
                amount = numeric(value)
                if CODE.fullmatch(key) and amount is not None:
                    if key in values:
                        raise ValueError("currency_collision")
                    values[key] = amount
            if not values:
                continue
            if not base:
                raise ValueError("base_unknown")
            if base in values and values[base] != 1:
                raise ValueError("base_not_identity")
            values[base] = Decimal(1)
            if "USD" not in values:
                raise ValueError("usd_bridge_missing")
            normalized = {key: Fraction(value) / Fraction(values["USD"]) for key, value in values.items()}
            return {"base": base, "source_rates": values, "usd_ratios": normalized}
    raise ValueError("quotes_missing")


def source_time(payload, field=None, precision=None):
    if field is None:
        return ("unknown", None)
    value = payload
    for part in field.split("."):
        if not isinstance(value, dict) or part not in value:
            return ("unknown", None)
        value = value[part]
    if precision in ("epoch_seconds", "epoch_millis"):
        if isinstance(value, bool) or not isinstance(value, (int, str, Decimal)):
            raise ValueError("source_time_invalid")
        text = str(value)
        if len(text) > 128 or not NUMBER.fullmatch(text):
            raise ValueError("source_time_invalid")
        raw = Decimal(text)
        if not raw.is_finite() or abs(raw.adjusted()) > 64:
            raise ValueError("source_time_invalid")
        parts = raw.as_tuple()
        if len(parts.digits) > 128 or abs(parts.exponent) > 256:
            raise ValueError("source_time_invalid")
        lower, upper = (
            (-62135596800, 253402300800)
            if precision == "epoch_seconds"
            else (-62135596800000, 253402300800000)
        )
        if raw < lower or raw >= upper:
            raise ValueError("source_time_invalid")
        micros = Fraction(raw) * (1000000 if precision == "epoch_seconds" else 1000)
        if micros.denominator != 1:
            raise ValueError("source_time_precision_unsupported")
        try:
            parsed = datetime(1970, 1, 1, tzinfo=UTC) + timedelta(microseconds=int(micros))
        except (OverflowError, ValueError):
            raise ValueError("source_time_invalid") from None
        return ("instant", parsed.isoformat())
    if precision == "date" and isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return ("date", date.fromisoformat(value).isoformat())
    if precision == "instant" and isinstance(value, str):
        match = re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.,]([0-9]+))?(?:Z|[+-][0-9]{2}:[0-9]{2})",
            value,
        )
        if not match:
            raise ValueError("source_time_invalid")
        fraction = match.group(1) or ""
        if any(digit != "0" for digit in fraction[6:]):
            raise ValueError("source_time_precision_unsupported")
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is not None:
            return ("instant", parsed.isoformat())
    raise ValueError("source_time_invalid")


def approved_target(url, approval, resolved_ips):
    """Validate an approved origin/path and resolved IP pins without opening a socket."""
    parsed = urlsplit(url)
    if parsed.username or parsed.password or parsed.fragment or parsed.scheme not in ("http", "https"):
        raise ValueError("target_invalid")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    actual = (parsed.scheme, parsed.hostname, port, parsed.path or "/")
    if actual != tuple(approval["target"]):
        raise ValueError("target_not_approved")
    if not resolved_ips or not set(resolved_ips) <= set(approval["addresses"]):
        raise ValueError("address_not_approved")
    if parsed.scheme == "http" and not approval.get("allow_plaintext"):
        raise ValueError("plaintext_not_approved")
    return tuple(resolved_ips)
