"""One pinned provider-model protocol request, original bytes before interpretation."""

import asyncio
import ipaddress
import json
import math
import time
from urllib.parse import urlsplit

import httpcore

from .fx_provider_parser import unique
from .fx_provider_transport import PinnedBackend, resolve

LIMIT = 262144


PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(value)
    for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "fc00::/7", "::1/128")
)


def private_model_address(value):
    address = ipaddress.ip_address(value)
    return any(address.version == network.version and address in network for network in PRIVATE_NETWORKS)


def approved_model_target(url, policy, resolved_ips):
    parsed = urlsplit(url)
    if (
        parsed.scheme not in {"https", "http"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not parsed.hostname
    ):
        raise ValueError("model_endpoint_invalid")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if (parsed.hostname, port, parsed.path) != (policy["host"], policy["port"], policy["path"]):
        raise ValueError("model_endpoint_not_approved")
    pins = policy["addresses"]
    if (
        not isinstance(pins, list)
        or not 1 <= len(pins) <= 32
        or not resolved_ips
        or not set(resolved_ips) <= set(pins)
    ):
        raise ValueError("model_address_not_approved")
    for value in pins:
        address = ipaddress.ip_address(value)
        if private_model_address(value):
            if policy.get("allowPrivate") is not True:
                raise ValueError("private_model_not_approved")
        elif (
            not address.is_global
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
            or address.is_link_local
        ):
            raise ValueError("model_address_forbidden")
    if parsed.scheme == "http" and (
        policy.get("allowPrivate") is not True
        or policy.get("allowPlaintext") is not True
        or not all(private_model_address(v) for v in pins)
    ):
        raise ValueError("public_plaintext_model_forbidden")
    return tuple(resolved_ips)


def payload(target):
    provider = target["provider"]
    model = target["model"]
    if provider == "jev":
        return {
            "model": model,
            "state": "The quote source returned a timeout.",
            "questions": {"needs_review": {"type": "noul", "instructions": "Did the quote source time out?"}},
        }
    value = {
        "model": model,
        "temperature": 0,
        "stream": False,
        "messages": [{"role": "user", "content": "只回复 OK"}],
    }
    value["max_completion_tokens" if provider == "openai" else "max_tokens"] = 512
    if provider == "openai":
        value.pop("temperature", None)
    if provider == "deepseek":
        value["thinking"] = {"type": "disabled"}
    return value


async def read(target):
    url = target["url"]
    parsed = urlsplit(url)
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    approval = target["approval"]
    approved_model_target(url, approval, approval["addresses"])
    token = target["apiKey"]
    if not isinstance(token, str) or not token or any(c in token for c in "\r\n\0"):
        raise ValueError("provider_secret_invalid")
    started = time.monotonic()
    result=None;raw=bytearray()
    try:
        async with asyncio.timeout(30):
            pins=approved_model_target(url,approval,await resolve(host,port))
            async with httpcore.AsyncConnectionPool(network_backend=PinnedBackend(host,port,pins[0]),retries=0,max_connections=1)as pool:
                async with pool.stream('POST',url,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Accept-Encoding':'identity'},
                    content=json.dumps(payload(target),ensure_ascii=False).encode(),extensions={'timeout':{'connect':5,'read':25,'write':10,'pool':5}})as response:
                    result={'raw':b'','status':response.status,'complete':False,'latencyMs':0}
                    async for chunk in response.aiter_stream():
                        remaining=LIMIT-len(raw);raw.extend(chunk[:remaining])
                        if len(chunk)>remaining:break
                    else:result['complete']=True
    except (Exception,asyncio.CancelledError):
        if result is None:raise
    result.update(raw=bytes(raw),latencyMs=round((time.monotonic()-started)*1000))
    return result



def interpreted(raw, provider):
    data = json.loads(
        raw,
        object_pairs_hook=unique,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("provider_nonfinite")),
    )
    if provider == "jev":
        answer = data["answers"]["needs_review"]
        number = answer.get("noul")
        return (
            answer.get("type") == "noul"
            and type(number) in (int, float)
            and math.isfinite(number)
            and 0 <= number <= 1
        )
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return False
    choice = choices[0]
    content = choice.get("message", {}).get("content")
    return choice.get("finish_reason") == "stop" and isinstance(content, str) and bool(content.strip())
