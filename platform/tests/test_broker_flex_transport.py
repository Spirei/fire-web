"""Controlled protocol and HTTP boundaries only; no broker connection or PG."""

from contextlib import asynccontextmanager

import pytest
from alcor_api.broker_flex_transport import MAX_BYTES, Target, Transport, interpret

TOKEN = 'SYNTHETICFLEXTOKEN99'


def response(code=None, reference=None, url=''):
    status = 'Success' if reference else 'Fail'
    return (f'<FlexStatementResponse><Status>{status}</Status>'
            f'{"<ReferenceCode>"+reference+"</ReferenceCode>" if reference else ""}'
            f'{"<ErrorCode>"+code+"</ErrorCode>" if code else ""}'
            f'<url>{url}</url></FlexStatementResponse>').encode()


def test_original_reference_pending_and_invalid_credentials_never_fake_success():
    for code in ('1003', '1019'):
        result = interpret(response(code), 200, reference='123')
        assert (result.state, result.reference, result.raw, result.complete) == ('pending', '123', response(code), True)
        assert interpret(response(code), 200).state == 'unknown'
    for code in ('1012', '1014', '1015'):
        result = interpret(response(code), 200, reference='123')
        assert (result.state, result.client_status, result.error_code) == ('rejected', 422, code)
    assert interpret(response('1018'), 200, reference='123').state == 'unknown'
    result = interpret(response(reference='123', url='https://other.invalid/private'), 200)
    assert (result.state, result.reference) == ('pending', '123')
    assert interpret(response(reference='456'), 200, reference='123').state == 'unknown'


def test_control_parser_forbids_entities_ambiguity_and_preserves_original_bytes():
    for raw in (b'<!DOCTYPE x [<!ENTITY e "secret">]><FlexStatementResponse/>',
                b'<FlexStatementResponse><Status>Success</Status><Status>Success</Status><ReferenceCode>1</ReferenceCode></FlexStatementResponse>',
                b'\xff<FlexQueryResponse/>'):
        result = interpret(raw, 200)
        assert result.state == 'unknown' and result.raw == raw and result.complete
    raw = b'<?xml version="1.0"?>\n<FlexQueryResponse><FlexStatements/></FlexQueryResponse>\n'
    result = interpret(raw, 200, reference='123')
    assert result.state == 'statement' and result.raw == raw and result.http_status == 200
    assert 'FlexQueryResponse' not in repr(result)
    result = interpret(b'redirect body', 302)
    assert result.state == 'unknown' and result.raw == b'redirect body'


class ControlledPool:
    def __init__(self, calls, chunks, *, status=200, fail_after=False):
        self.calls, self.chunks, self.status, self.fail_after = calls, chunks, status, fail_after

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.calls.append('pool_closed')

    @asynccontextmanager
    async def stream(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        yield self

    async def aiter_stream(self):
        for chunk in self.chunks:
            yield chunk
        if self.fail_after:
            raise RuntimeError('third-party error may contain '+TOKEN)


async def test_send_and_get_each_issue_only_one_pinned_fixed_request():
    calls, connections = [], []

    async def resolver(host, port):
        assert host == 'ndcdyn.interactivebrokers.com' and port == 443
        return ['8.8.8.8']

    def backend(host, port, pin):
        connections.append((host, port, pin))
        return object()

    def pool(**kwargs):
        assert kwargs['retries'] == 0 and kwargs['max_connections'] == 1
        return ControlledPool(calls, [response(reference='123', url='https://other.invalid/GetStatement')])

    transport = Transport(resolver=resolver, backend_factory=backend, pool_factory=pool)
    result = await transport.request(TOKEN, '42', target=Target(('8.8.8.8',)))
    assert result.state == 'pending'
    assert len([call for call in calls if isinstance(call, tuple)]) == 1
    assert '/SendRequest?' in calls[0][1] and 'q=42&v=3' in calls[0][1]
    calls.clear()
    await transport.request(TOKEN, '42', reference='123', target=Target(('8.8.8.8',)))
    assert '/GetStatement?' in calls[0][1] and 'q=123&v=3' in calls[0][1]
    assert len(connections) == 2


async def test_dns_mismatch_does_not_connect_and_partial_failures_keep_bounded_evidence():
    async def bad_dns(host, port):
        return ['127.0.0.1']

    def forbidden(*args, **kwargs):
        pytest.fail('unapproved connection')

    result = await Transport(resolver=bad_dns, backend_factory=forbidden).request(TOKEN, '42', target=Target(('8.8.8.8',)))
    assert result.state == 'unknown' and result.raw == b'' and result.http_status is None

    async def good_dns(host, port):
        return ['8.8.8.8']

    for chunks, fail, expected_status in (([b'partial xml'], True, 502), ([b'x'*MAX_BYTES, b'x'], False, 413)):
        calls = []
        result = await Transport(resolver=good_dns, backend_factory=lambda *a: object(),
                                 pool_factory=lambda calls=calls, chunks=chunks, fail=fail, **kw: ControlledPool(calls, chunks, fail_after=fail)).request(
                                     TOKEN, '42', reference='123', target=Target(('8.8.8.8',)))
        assert result.state == 'unknown' and not result.complete and result.http_status == 200
        assert result.client_status == expected_status and len(result.raw) <= MAX_BYTES
        assert result.reference == '123' and TOKEN not in repr(result)
        assert calls[-1] == 'pool_closed'
