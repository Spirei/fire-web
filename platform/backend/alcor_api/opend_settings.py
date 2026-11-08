"""Explicit administrator OpenD save, bound to one literal device and owner."""

from dataclasses import asdict
from hashlib import sha256
from ipaddress import ip_address

from fastapi import HTTPException

from .dividend_sources import Target
from .market_authority import Policy


def configured_opend(who, host, port):
    try:
        address = ip_address(str(host).strip())
        if address.is_unspecified or address.is_multicast or address.is_link_local:
            raise ValueError()
        if isinstance(port, bool) or not str(port).isdigit() or not 1 <= int(port) <= 65535:
            raise ValueError()
    except ValueError:
        raise HTTPException(422, "请填写 OpenD 设备的 IP 地址和有效端口") from None
    identifier = "opend-" + sha256(who.id.encode()).hexdigest()[:24]
    target = Target(identifier, "futu", str(address), int(port), (str(address),), approved_access=True, scheme="http", allow_plaintext=True)
    policy = Policy(identifier, "futu", "futu-sdk-records-v1", identifier, target.fingerprint, who.id, "opend-settings-v1", ("latest", "futu.test", "futu.quota"), ("US", "HK", "CN"))
    return asdict(target), asdict(policy)
