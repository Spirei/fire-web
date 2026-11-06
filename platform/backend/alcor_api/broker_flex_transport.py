"""One explicitly approved IBKR Flex request; no polling, retry or URL discovery.

The caller owns credential storage, UUID receipts and archival. Reply.raw is private
source evidence and must not be placed in a public response or log. Response URLs
and vendor ErrorMessage text are deliberately never used or propagated.
"""

import asyncio
import hashlib
import ipaddress
import json
import re
from dataclasses import dataclass, field
from urllib.parse import urlencode
from xml.parsers import expat

import httpcore

from .broker_flex import MAX_BYTES
from .fx_provider_parser import approved_target
from .fx_provider_transport import PinnedBackend, resolve

HOST = 'ndcdyn.interactivebrokers.com'
BASE_PATH = '/AccountManagement/FlexWebService/'
REFERENCE = re.compile(r'[0-9]{1,40}\Z', re.ASCII)
INVALID_CREDENTIAL_CODES = frozenset({'1012', '1014', '1015'})


@dataclass(frozen=True)
class Target:
    addresses: tuple[str, ...]
    id: str = 'ibkr-flex'

    def validate(self):
        if not isinstance(self.id, str) or not re.fullmatch(r'[a-zA-Z0-9._-]{1,128}', self.id, re.ASCII):
            raise ValueError('flex_target_invalid')
        if not isinstance(self.addresses, (tuple, list)) or not 1 <= len(self.addresses) <= 32:
            raise ValueError('flex_public_dns_approval_required')
        for address in self.addresses:
            if not isinstance(address, str):
                raise TypeError('flex_public_dns_approval_required')
            parsed = ipaddress.ip_address(address)
            if not parsed.is_global or parsed.is_multicast or parsed.is_reserved:
                raise ValueError('flex_public_dns_approval_required')
        return self

    @property
    def fingerprint(self):
        self.validate()
        payload = {'id': self.id, 'host': HOST, 'port': 443, 'path': BASE_PATH,
                   'addresses': sorted(set(self.addresses)), 'protocol': 'ibkr-flex-v3'}
        return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    def approval(self, action):
        self.validate()
        if action not in ('SendRequest', 'GetStatement'):
            raise ValueError('flex_action_invalid')
        return {'target': ('https', HOST, 443, BASE_PATH+action), 'addresses': list(self.addresses)}


@dataclass(frozen=True)
class Reply:
    state: str
    reference: str | None = None
    raw: bytes = field(default=b'', repr=False)
    http_status: int | None = None
    complete: bool = False
    error_code: str | None = None
    client_status: int = 502
    error: str | None = None


def credentials(token, query_id, reference=None):
    if (not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9]{10,256}', token, re.ASCII)
            or not isinstance(query_id, str) or not re.fullmatch(r'[0-9]{1,20}', query_id, re.ASCII)
            or reference is not None and (not isinstance(reference, str) or not REFERENCE.fullmatch(reference))):
        raise ValueError('flex_credentials_invalid')


def control(raw):
    """Bounded UTF-8 XML parser, no DTD/entity expansion or business interpretation."""
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_BYTES:
        raise ValueError('flex_xml_invalid')
    text = raw.decode('utf-8', errors='strict')
    parser = expat.ParserCreate()
    stack, fields, root = [], {}, None
    count = 0

    def forbidden(*args):
        raise ValueError('flex_xml_forbidden')

    def start(name, attrs):
        nonlocal count, root
        count += 1
        if count > 100000 or len(stack) >= 24:
            raise ValueError('flex_xml_complex')
        if root is None:
            root = name
        stack.append(name)
        if root == 'FlexStatementResponse' and name in ('Status', 'ReferenceCode', 'ErrorCode'):
            if name in fields:
                raise ValueError('flex_control_ambiguous')
            fields[name] = []

    def characters(value):
        if root == 'FlexStatementResponse' and stack and stack[-1] in fields:
            fields[stack[-1]].append(value)

    parser.StartElementHandler = start
    parser.EndElementHandler = lambda _: stack.pop()
    parser.CharacterDataHandler = characters
    parser.StartDoctypeDeclHandler = forbidden
    parser.EntityDeclHandler = forbidden
    parser.ExternalEntityRefHandler = forbidden
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    parser.Parse(text, True)
    return root, {name: ''.join(chunks).strip() for name, chunks in fields.items()}


def interpret(raw, http_status, *, reference=None, complete=True):
    """Pure source classification: a pending reply never triggers another request."""
    if reference is not None and (not isinstance(reference, str) or not REFERENCE.fullmatch(reference)):
        raise ValueError('flex_reference_invalid')
    if type(http_status) is not int or not 100 <= http_status <= 599:
        raise ValueError('flex_http_status_invalid')
    if not isinstance(raw, bytes):
        raise TypeError('flex_bytes_required')
    if len(raw) > MAX_BYTES:
        raw, complete = raw[:MAX_BYTES], False
    common = {'raw': raw, 'http_status': http_status, 'complete': complete}
    if not complete:
        return Reply('unknown', reference=reference, client_status=413, error='flex_response_incomplete', **common)
    if http_status != 200:
        rejected = http_status in (401, 403)
        return Reply('rejected' if rejected else 'unknown', reference=reference,
                     client_status=422 if rejected else 502, error='flex_http_rejected' if rejected else 'flex_http_unknown', **common)
    try:
        root, values = control(raw)
    except (ValueError, UnicodeError, expat.ExpatError, RecursionError):
        return Reply('unknown', reference=reference, error='flex_protocol_invalid', **common)
    if root == 'FlexQueryResponse':
        return Reply('statement', reference=reference, client_status=200, **common)
    if root != 'FlexStatementResponse':
        return Reply('unknown', reference=reference, error='flex_protocol_invalid', **common)
    status, supplied, code = values.get('Status'), values.get('ReferenceCode'), values.get('ErrorCode')
    safe_code = code if isinstance(code, str) and re.fullmatch(r'[0-9]{1,10}', code, re.ASCII) else None
    if status == 'Success' and isinstance(supplied, str) and REFERENCE.fullmatch(supplied) and not code:
        if reference is not None and supplied != reference:
            return Reply('unknown', reference=reference, error='flex_reference_mismatch', **common)
        return Reply('pending', reference=supplied, client_status=200, **common)
    if code in INVALID_CREDENTIAL_CODES:
        return Reply('rejected', reference=reference, error_code=code, client_status=422, error='flex_credentials_rejected', **common)
    if reference is not None and code in ('1003', '1019'):
        return Reply('pending', reference=reference, error_code=code, client_status=200, **common)
    return Reply('unknown', reference=reference, error_code=safe_code, error='flex_source_unknown', **common)


class Transport:
    def __init__(self, *, resolver=resolve, backend_factory=PinnedBackend, pool_factory=None):
        self.resolver, self.backend_factory = resolver, backend_factory
        self.pool_factory = pool_factory or httpcore.AsyncConnectionPool

    async def request(self, token, query_id, *, reference=None, target):
        credentials(token, query_id, reference)
        if not isinstance(target, Target):
            raise TypeError('flex_explicit_target_required')
        action = 'GetStatement' if reference is not None else 'SendRequest'
        approval = target.approval(action)
        # Validate fixed origin before DNS; URL query cannot change the approved path.
        origin = 'https://'+HOST+BASE_PATH+action
        approved_target(origin, approval, approval['addresses'])
        raw, status, complete = bytearray(), None, False
        try:
            async with asyncio.timeout(20):
                pins = approved_target(origin, approval, await self.resolver(HOST, 443))
                backend = self.backend_factory(HOST, 443, pins[0])
                # Query contains credentials: never log this URL or exception details.
                url = origin+'?'+urlencode({'t': token, 'q': reference if reference is not None else query_id, 'v': '3'})
                async with (
                    self.pool_factory(network_backend=backend, retries=0, max_connections=1) as pool,
                    pool.stream('GET', url, headers={'User-Agent': 'Alcor/1.0', 'Accept-Encoding': 'identity'},
                                extensions={'timeout': {'connect': 5, 'read': 5, 'write': 5, 'pool': 5}}) as response,
                ):
                    status = response.status
                    async for chunk in response.aiter_stream():
                        remaining = MAX_BYTES - len(raw)
                        raw.extend(chunk[:remaining])
                        if len(chunk) > remaining:
                            return interpret(bytes(raw), status, reference=reference, complete=False)
                    complete = True
            return interpret(bytes(raw), status, reference=reference, complete=complete)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - third-party errors may contain the credential URL.
            # Do not chain, retain or emit exceptions that may include credential URLs.
            return Reply('unknown', reference=reference, raw=bytes(raw), http_status=status,
                         complete=complete, error='flex_transport_unknown')
