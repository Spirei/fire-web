"""Only reviewed metadata is public; complete request URL and credentials are sealed."""

import json
import re
from urllib.parse import urlsplit, urlunsplit

_ALLOWED = {"url", "approval", "bearer", "declared_base", "time_field", "time_precision", "schedule"}


def separate(config):
    if not isinstance(config, dict) or set(config) - _ALLOWED:
        raise ValueError("custom_fields_invalid")
    approval = config.get("approval")
    if not isinstance(approval, dict) or set(approval) - {"target", "addresses", "allow_plaintext"}:
        raise ValueError("approval_fields_invalid")
    if "allow_plaintext" in approval and type(approval["allow_plaintext"]) is not bool:
        raise ValueError("approval_plaintext_invalid")
    addresses = approval.get("addresses")
    if (
        not isinstance(addresses, list)
        or not 1 <= len(addresses) <= 32
        or any(not isinstance(address, str) for address in addresses)
    ):
        raise ValueError("approval_addresses_invalid")
    schedule = config.get("schedule")
    if schedule is not None and (not isinstance(schedule, dict) or set(schedule) != {"pattern", "timezone"}):
        raise ValueError("schedule_fields_invalid")
    base = config.get("declared_base")
    if base is not None and (not isinstance(base, str) or not re.fullmatch(r"[A-Z]{3}", base)):
        raise ValueError("base_invalid")
    field = config.get("time_field")
    if field is not None and (
        not isinstance(field, str)
        or len(field) > 200
        or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*", field)
    ):
        raise ValueError("time_field_invalid")
    precision = config.get("time_precision")
    if precision is not None and precision not in ("date", "instant", "epoch_seconds", "epoch_millis"):
        raise ValueError("time_precision_invalid")
    actual_url = config.get("url")
    if (
        not isinstance(actual_url, str)
        or not 1 <= len(actual_url) <= 2048
        or any(c.isspace() for c in actual_url)
    ):
        raise ValueError("url_invalid")
    url = urlsplit(actual_url)
    if (
        url.username
        or url.password
        or url.fragment
        or url.scheme not in ("https", "http")
        or not url.hostname
    ):
        raise ValueError("url_invalid")
    bearer = config.get("bearer")
    if bearer is not None and (
        not isinstance(bearer, str)
        or not 1 <= len(bearer) <= 4096
        or any(ord(c) < 33 or ord(c) > 126 for c in bearer)
    ):
        raise ValueError("credential_invalid")
    public = {
        key: config[key]
        for key in ("declared_base", "time_field", "time_precision", "schedule")
        if key in config
    }
    public["url"] = urlunsplit((url.scheme, url.netloc, "/[redacted]", "", ""))
    secret = {"url": actual_url, "approval": approval, "bearer": bearer}
    return public, json.dumps(secret, ensure_ascii=True)


def materialize(config, credential):
    request = json.loads(credential)
    url = urlsplit(request["url"])
    if urlunsplit((url.scheme, url.netloc, "/[redacted]", "", "")) != config["url"]:
        raise ValueError("credential_origin_mismatch")
    bearer = request.get("bearer")
    return request["url"], {"Authorization": "Bearer " + bearer} if bearer else {}


def display(config):
    return {
        key: config[key]
        for key in ("url", "declared_base", "time_field", "time_precision", "schedule")
        if key in config
    }
