"""SDK coalescing preserves exact securities, clocks and authorization scopes."""

import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from alcor_api.market_latest_batch import LatestBatch
from alcor_api.sdk_read_session import SDKReadRejected


def request(symbol, *, session='REGULAR', host='192.0.2.1'):
    return {'action': 'latest', 'host': host, 'port': 11111, 'symbols': [symbol],
            'query': {'market': symbol.split('.')[0], 'code': symbol.split('.')[1],
                      'frame': 'latest', 'adjust': 'none', 'session': session}, 'cursor': None}


class Source:
    def __init__(self):
        self.calls = []

    async def read(self, payload):
        self.calls.append(payload)
        return json.dumps({'records': [
            {'code': symbol, 'last_price': 17.25, 'update_time': '2026-11-12 16:00:00'}
            for symbol in payload['symbols'] if symbol != 'US.OTC'
        ], 'realTimeRecords': [
            {'code': symbol, 'cur_price': 17.31, 'time': '2026-11-13 04:01:00'}
            for symbol in payload['symbols'] if symbol != 'US.OTC'
        ], 'skipped': ['US.OTC'] if 'US.OTC' in payload['symbols'] else []}).encode()


async def test_same_authority_coalesces_but_each_observer_gets_only_its_exact_records():
    source = Source()
    batch = LatestBatch(source)
    try:
        rows = await asyncio.gather(*(batch.read(('owner', 'source', 'license', 'target'), request(symbol))
                                      for symbol in ('US.AAPL', 'US.MSFT', 'US.AAPL', 'US.OTC')),
                                    return_exceptions=True)
        assert len(source.calls) == 1 and source.calls[0]['symbols'] == ['US.AAPL', 'US.MSFT', 'US.OTC']
        for raw, symbol in zip(rows[:3], ('US.AAPL', 'US.MSFT', 'US.AAPL'), strict=True):
            value = json.loads(raw)
            assert value['records'] == [{'code': symbol, 'last_price': 17.25, 'update_time': '2026-11-12 16:00:00'}]
            assert value['realTimeRecords'] == [{'code': symbol, 'cur_price': 17.31, 'time': '2026-11-13 04:01:00'}]
            assert value['skipped'] == []
        assert isinstance(rows[3], SDKReadRejected)
    finally:
        await batch.close()


async def test_owner_license_target_market_and_session_never_share_a_batch():
    source = Source()
    batch = LatestBatch(source)
    cases = [(('owner', 'source', 'license', 'target'), request('US.AAPL')),
             (('other', 'source', 'license', 'target'), request('US.MSFT')),
             (('owner', 'source', 'new-license', 'target'), request('US.MSFT')),
             (('owner', 'source', 'license', 'new-target'), request('US.MSFT')),
             (('owner', 'source', 'license', 'target'), request('HK.00700')),
             (('owner', 'source', 'license', 'target'), request('US.MSFT', session='PRE')),
             (('owner', 'source', 'license', 'target'), request('US.MSFT', host='192.0.2.2'))]
    try:
        await asyncio.gather(*(batch.read(scope, payload) for scope, payload in cases))
        assert len(source.calls) == len(cases)
    finally:
        await batch.close()


async def test_114_securities_use_six_bounded_sdk_requests_with_no_cross_security_rows():
    source=Source()
    batch=LatestBatch(source)
    symbols=[f'US.SYN{i:03}' for i in range(114)]
    try:
        results=await asyncio.gather(*(batch.read(('owner','source','license','target'),request(symbol)) for symbol in symbols))
        assert len(source.calls)==6
        assert max(len(call['symbols']) for call in source.calls)==20
        for symbol,raw in zip(symbols,results,strict=True):
            assert [row['code'] for row in json.loads(raw)['records']]==[symbol]
    finally:
        await batch.close()


async def test_http_provider_reads_remain_limited_to_six_while_worker_batches_twenty(monkeypatch):
    from alcor_api.market_transport import Transport

    running=maximum=0
    async def controlled_page(*_):
        nonlocal running,maximum
        running+=1
        maximum=max(maximum,running)
        await asyncio.sleep(.005)
        running-=1
        return b'controlled response'
    monkeypatch.setattr('alcor_api.market_transport.fetch_page',controlled_page)
    transport=Transport(SimpleNamespace(settings=SimpleNamespace(environment='test')),
        controlled_http={'controlled':('http://127.0.0.1/quote',{'addresses':['127.0.0.1']})})
    try:
        await asyncio.gather(*(transport.read(SimpleNamespace(fixture=True,id='controlled'),None,None) for _ in range(114)))
        assert maximum==6 and running==0
    finally:
        await transport.close()


async def test_cancelled_observer_does_not_cancel_other_security_and_close_rejects_late_reads():
    class Blocked(Source):
        async def read(self, payload):
            entered.set()
            await release.wait()
            return await super().read(payload)

    entered, release = asyncio.Event(), asyncio.Event()
    source, scope = Blocked(), ('owner', 'source', 'license', 'target')
    batch = LatestBatch(source)
    first = asyncio.create_task(batch.read(scope, request('US.AAPL')))
    second = asyncio.create_task(batch.read(scope, request('US.MSFT')))
    await entered.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    assert json.loads(await second)['records'][0]['code'] == 'US.MSFT'
    await batch.close()
    assert not batch.tasks and not batch.pending
    with pytest.raises(SDKReadRejected):
        await batch.read(scope, request('US.AAPL'))


async def test_real_worker_batch_is_bounded_and_awaits_all_failed_and_successful_children(monkeypatch):
    from alcor_api import market_runtime as runtime

    tasks = [{'id': uuid4()} for _ in range(114)]
    running = maximum = completed = 0
    calls = []

    async def noop(*args):
        pass

    async def claim(_db, _worker, *, kind):
        calls.append(kind)
        return tasks.pop(0) if kind == 'market.latest' and tasks else None

    async def execute(_authority, task, _transport):
        nonlocal running, maximum, completed
        running += 1
        maximum = max(maximum, running)
        await asyncio.sleep(.001)
        running -= 1
        completed += 1
        if completed % 7 == 0:
            raise ValueError('controlled_provider_failure')
        return 'observed'

    for name, value in (('project_alert_demands', noop), ('schedule', noop), ('claim', claim), ('execute', execute)):
        monkeypatch.setattr(runtime, name, value)
    authority = SimpleNamespace(db=None)
    while await runtime.batch_cycle(authority, None, uuid4(), history_turn=True):
        assert running == 0
    assert completed == 114 and maximum == 20 and calls.count('market.history') >= 6
    with pytest.raises(ValueError):
        await runtime.batch_cycle(authority, None, uuid4(), maximum=21)
