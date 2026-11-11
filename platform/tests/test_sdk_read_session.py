import asyncio
import json

import pytest

from alcor_api.sdk_read_session import LatestSDKSession, SDKReadRejected


@pytest.fixture
def child(tmp_path):
    script = tmp_path/'controlled_sdk.py'
    script.write_text('''import json,os,sys,time
for line in sys.stdin:
    value=json.loads(line); symbol=value['symbols'][0]
    if symbol=='HANG':time.sleep(30)
    if symbol=='HUGE':print('x'*140000,flush=True);continue
    if symbol=='REFUSED':print('{"error":"refused"}',flush=True);continue
    print(json.dumps({'pid':os.getpid(),'records':[{'code':symbol}]}),flush=True)
''')
    return script


def request(symbol, host='127.0.0.1'):
    return {'action':'latest','host':host,'port':11111,'symbols':[symbol]}


async def test_reads_reuse_import_but_keep_securities_and_refusal_independent(child):
    session = LatestSDKSession(child)
    try:
        rows = await asyncio.gather(*(session.read(request(symbol)) for symbol in ('US.AAPL','HK.00700','US.MSFT')))
        observed = [json.loads(row) for row in rows]
        assert len({row['pid'] for row in observed})==1
        assert [row['records'][0]['code'] for row in observed]==['US.AAPL','HK.00700','US.MSFT']
        with pytest.raises(SDKReadRejected):
            await session.read(request('REFUSED'))
        following=json.loads(await session.read(request('US.AAPL')))
        assert following['pid']==observed[0]['pid'] and following['records']==[{'code':'US.AAPL'}]
    finally:
        process=session.process
        await session.close()
        assert process.returncode is not None and session.process is None


async def test_pin_change_and_capacity_retire_the_previous_child(child):
    session=LatestSDKSession(child,maximum=2)
    try:
        first=json.loads(await session.read(request('US.AAPL')))
        old=session.process
        assert json.loads(await session.read(request('US.MSFT')))['pid']==first['pid']
        assert json.loads(await session.read(request('HK.00700')))['pid']!=first['pid']
        assert old.returncode is not None
        old=session.process
        await session.read(request('US.AAPL','127.0.0.2'))
        assert old.returncode is not None
        active=session.process
        await session.retire_idle()
        assert session.process is active
        session.last_used -= 91
        await session.retire_idle()
        assert active.returncode is not None and session.process is None
    finally:await session.close()


@pytest.mark.parametrize('failure',['timeout','cancel','oversize'])
async def test_failed_read_cannot_supply_a_late_response_to_next_security(child,failure):
    session=LatestSDKSession(child,timeout=.3)
    try:
        await session.read(request('US.AAPL'))
        old=session.process
        if failure=='cancel':
            task=asyncio.create_task(session.read(request('HANG')))
            await asyncio.sleep(.03)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):await task
        else:
            with pytest.raises(TimeoutError if failure=='timeout' else ValueError):
                await session.read(request('HANG' if failure=='timeout' else 'HUGE'))
        assert old.returncode is not None and session.process is None
        next_row=json.loads(await session.read(request('HK.00700')))
        assert next_row['pid']!=old.pid and next_row['records']==[{'code':'HK.00700'}]
    finally:await session.close()


async def test_waiting_reader_timeout_keeps_the_active_request_owned_by_its_observer(child):
    session=LatestSDKSession(child,timeout=1)
    try:
        await session.read(request('US.AAPL'))
        active=asyncio.create_task(session.read(request('HANG')))
        await asyncio.sleep(.03)
        process=session.process
        session.timeout=.03
        with pytest.raises(TimeoutError):await session.read(request('US.MSFT'))
        assert session.process is process and process.returncode is None and not active.done()
        active.cancel()
        with pytest.raises(asyncio.CancelledError):await active
        assert process.returncode is not None
    finally:await session.close()


def test_actual_sdk_entry_stream_keeps_existing_conversion_and_closes_each_context(monkeypatch):
    import io
    import sys
    from types import ModuleType, SimpleNamespace
    from alcor_api import market_futu_sdk as sdk

    contexts=[]
    class Frame:
        def __init__(self, symbol):self.symbol=symbol
        def to_dict(self, orient):
            assert orient=='records'
            return [{'code':self.symbol,'last_price':12.5,'unknown':float('nan')}]
    class Context:
        def __init__(self, **kwargs):self.closed=False;contexts.append(self)
        def get_market_snapshot(self, symbols):
            return (1,'private provider error') if symbols==['US.REFUSED'] else (0,Frame(symbols[0]))
        def close(self):self.closed=True
    futu=ModuleType('futu')
    for key,value in {'RET_OK':0,'OpenQuoteContext':Context,'AuType':None,'KLType':None,'Session':None,'SubType':None}.items():
        setattr(futu,key,value)
    logger=ModuleType('futu.common.ft_logger')
    logger.logger=SimpleNamespace(file_logger=SimpleNamespace(handlers=[]))
    monkeypatch.setitem(sys.modules,'futu',futu)
    monkeypatch.setitem(sys.modules,'futu.common.ft_logger',logger)
    payloads=[request('US.AAPL'),request('US.REFUSED'),{**request('US.AAPL'),'action':'history'},request('HK.00700')]
    source=io.TextIOWrapper(io.BytesIO(('\n'.join(map(json.dumps,payloads))+'\n').encode()))
    output=io.StringIO()
    monkeypatch.setattr(sys,'stdin',source)
    monkeypatch.setattr(sys,'__stdout__',output)
    monkeypatch.setattr(sys,'argv',['sdk','--latest-stream'])
    sdk.main()
    rows=list(map(json.loads,output.getvalue().splitlines()))
    assert len(rows)==4 and len(contexts)==3 and all(context.closed for context in contexts)
    assert rows[0]['records']==[{'code':'US.AAPL','last_price':12.5,'unknown':None}]
    assert rows[1]==rows[2]=={'error':'sdk_read_unavailable'}
    assert rows[3]['records'][0]['code']=='HK.00700'
    assert all(row.get('representation')=='sdk_json_representation_not_wire_bytes' for row in (rows[0],rows[3]))
    assert 'private' not in output.getvalue()


@pytest.mark.parametrize('state',['active','retired','database_unavailable'])
async def test_worker_closes_the_import_lane_on_retirement_stop_and_failed_cycle(monkeypatch,state):
    from alcor_api import market_runtime, public_market_worker
    stop=asyncio.Event()
    class Lane:
        closed=0
        retired=0
        async def close(self):self.closed+=1;stop.set()
        async def retire_idle(self):self.retired+=1
    lane=Lane()
    def configured(db, *, reuse_latest=False):
        assert reuse_latest is True
        return object(),lane
    async def cycle(*args):
        stop.set()
        if state=='database_unavailable':raise RuntimeError('controlled unavailable')
    async def public(*args):pass
    monkeypatch.setattr(market_runtime,'from_settings',configured)
    monkeypatch.setattr(market_runtime,'cycle',cycle)
    monkeypatch.setattr(public_market_worker,'cycle',public)
    await market_runtime.loop(object(),stop,current=lambda:state!='retired')
    assert lane.closed==(2 if state=='retired' else 1) and lane.retired==1
