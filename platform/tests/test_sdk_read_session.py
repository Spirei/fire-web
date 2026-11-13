import asyncio
import json

import pytest

from alcor_api.sdk_read_session import HistorySDKSession, LatestSDKSession, SDKReadRejected


@pytest.fixture
def child(tmp_path):
    script = tmp_path/'controlled_sdk.py'
    script.write_text('''import json,os,sys,time
print('{"ready":true,"protocol":"futu-read-v1"}',flush=True)
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


async def test_slow_import_is_bounded_and_shared_without_sending_timed_out_security(tmp_path):
    script=tmp_path/'slow_import.py'
    script.write_text('''import json,os,sys,time
time.sleep(.5)
print('{"ready":true,"protocol":"futu-read-v1"}',flush=True)
for line in sys.stdin:
    print(json.dumps({'pid':os.getpid(),'symbol':json.loads(line)['symbols'][0]}),flush=True)
''')
    session=LatestSDKSession(script,timeout=.2,startup_timeout=2)
    try:
        with pytest.raises(TimeoutError):await session.read(request('US.OLD'))
        process=session.process
        assert process is not None and process.returncode is None and session.reads==0
        await asyncio.sleep(.6)
        value=json.loads(await session.read(request('HK.NEW')))
        assert value=={'pid':process.pid,'symbol':'HK.NEW'} and session.reads==1
    finally:await session.close()
    assert process.returncode is not None and session.starting is None


async def test_import_timeout_and_invalid_ready_protocol_retire_the_owned_process(tmp_path):
    for name,body,error in [('hang','import time;time.sleep(10)',TimeoutError),('invalid','print(\'{"records":[]}\',flush=True)',ValueError)]:
        script=tmp_path/(name+'.py');script.write_text(body)
        session=LatestSDKSession(script,timeout=.2,startup_timeout=.1)
        try:
            with pytest.raises(error):await session.read(request('US.AAPL'),startup_wait=True)
            assert session.process is None and session.starting is None
        finally:await session.close()


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


async def test_history_import_reuses_exact_cursor_and_adjustment_with_separate_protocol(tmp_path):
    script=tmp_path/'history_sdk.py'
    script.write_text('''import json,os,sys,time
assert sys.argv[1:]==['--history-stream']
time.sleep(.12)
print('{"ready":true,"protocol":"futu-history-read-v1"}',flush=True)
for line in sys.stdin:
    value=json.loads(line)
    if value.get('cursor')=='HANG':time.sleep(10)
    print(json.dumps({'pid':os.getpid(),'request':value}),flush=True)
''')
    session=HistorySDKSession(script,timeout=.08,startup_timeout=1)
    payload={**request('US.AAPL'),'action':'history','query':{'adjust':'qfq','frame':'day'},'cursor':None}
    try:
        first=json.loads(await session.read(payload,startup_wait=True))
        second=json.loads(await session.read({**payload,'cursor':'original-page-key'},startup_wait=True))
        assert first['pid']==second['pid']
        assert first['request']==payload and second['request']=={**payload,'cursor':'original-page-key'}
        process=session.process
        with pytest.raises(ValueError,match='sdk_stream_action_invalid'):
            await session.read(request('US.AAPL'))
        assert session.process is process and session.reads==2
        blocked=asyncio.create_task(session.read({**payload,'cursor':'HANG'},startup_wait=True))
        await asyncio.sleep(.02)
        async with asyncio.timeout(.03):await session.retire_idle()
        assert not blocked.done() and session.process is process
        blocked.cancel()
        with pytest.raises(asyncio.CancelledError):await blocked
        assert process.returncode is not None and session.process is None
        # A late old page cannot become another security's response.
        following=json.loads(await session.read({**payload,'symbols':['HK.00700']},startup_wait=True))
        assert following['pid']!=process.pid and following['request']['symbols']==['HK.00700']
    finally:await session.close()


async def test_history_session_refuses_latest_ready_protocol(child):
    session=HistorySDKSession(child)
    try:
        with pytest.raises(ValueError,match='sdk_startup_protocol_invalid'):
            await session.read({**request('US.AAPL'),'action':'history'},startup_wait=True)
        assert session.process is None
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
        def get_global_state(self):return 0,{'qot_logined':True}
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
    payloads=[request('US.AAPL'),request('US.REFUSED'),{**request('US.AAPL'),'action':'history'},request('HK.00700'),
              {'action':'futu.test','host':'192.0.2.10','port':11111,'quoteProbe':True}]
    source=io.TextIOWrapper(io.BytesIO(('\n'.join(map(json.dumps,payloads))+'\n').encode()))
    output=io.StringIO()
    monkeypatch.setattr(sys,'stdin',source)
    monkeypatch.setattr(sys,'__stdout__',output)
    monkeypatch.setattr(sys,'argv',['sdk','--latest-stream'])
    sdk.main()
    messages=list(map(json.loads,output.getvalue().splitlines()))
    assert messages[0]=={'ready':True,'protocol':'futu-read-v1'}
    rows=messages[1:]
    assert len(rows)==5 and len(contexts)==4 and all(context.closed for context in contexts)
    assert rows[0]['records']==[{'code':'US.AAPL','last_price':12.5,'unknown':None}]
    assert rows[1]==rows[2]=={'error':'sdk_read_unavailable'}
    assert rows[3]['records'][0]['code']=='HK.00700'
    assert rows[4]['responded'] is True and rows[4]['quote']=={'code':'US.AAPL','price':12.5}
    assert all(type(rows[4][key]) is int and rows[4][key]>=0 for key in ('sdkStartupMs','connectionElapsedMs'))
    assert all(row.get('representation')=='sdk_json_representation_not_wire_bytes' for row in (rows[0],rows[3]))
    assert 'private' not in output.getvalue()


def test_actual_history_entry_keeps_latest_protocol_closed_and_original_sdk_page_contract(monkeypatch):
    import base64
    import io
    import sys
    from types import ModuleType, SimpleNamespace
    from alcor_api import market_futu_sdk as sdk

    contexts=[]
    class Frame:
        def to_dict(self, orient):return [{'code':'US.AAPL','close':12.5,'unknown':float('nan')}]
    class Context:
        def __init__(self, **kwargs):self.closed=False;self.calls=[];contexts.append(self)
        def request_history_kline(self, symbol, **kwargs):
            self.calls.append((symbol,kwargs));return 0,Frame(),b'provider-next'
        def close(self):self.closed=True
    futu=ModuleType('futu')
    for key,value in {'RET_OK':0,'OpenQuoteContext':Context,
                      'AuType':SimpleNamespace(QFQ='original-qfq'),
                      'KLType':SimpleNamespace(K_DAY='original-day'),'Session':None,'SubType':None}.items():
        setattr(futu,key,value)
    logger=ModuleType('futu.common.ft_logger')
    logger.logger=SimpleNamespace(file_logger=SimpleNamespace(handlers=[]))
    monkeypatch.setitem(sys.modules,'futu',futu)
    monkeypatch.setitem(sys.modules,'futu.common.ft_logger',logger)
    payload={**request('US.AAPL'),'action':'history','cursor':base64.b64encode(b'original-page').decode(),
             'query':{'frame':'day','adjust':'qfq','session':'REGULAR','start':'2026-10-01','through':'2026-10-31'}}
    payloads=[payload,request('US.AAPL'),{**payload,'action':'price_series'},payload]
    monkeypatch.setattr(sys,'stdin',io.TextIOWrapper(io.BytesIO(('\n'.join(map(json.dumps,payloads))+'\n').encode())))
    output=io.StringIO();monkeypatch.setattr(sys,'__stdout__',output)
    monkeypatch.setattr(sys,'argv',['sdk','--history-stream'])
    sdk.main()
    messages=list(map(json.loads,output.getvalue().splitlines()))
    assert messages[0]=={'ready':True,'protocol':'futu-history-read-v1'}
    assert messages[2:4]==[{'error':'sdk_read_unavailable'}]*2
    assert len(contexts)==2 and all(context.closed for context in contexts)
    assert all(context.calls==[('US.AAPL',{'start':'2026-10-01','end':'2026-10-31','ktype':'original-day',
        'autype':'original-qfq','max_count':100,'page_req_key':b'original-page','extended_time':False})] for context in contexts)
    assert messages[1]==messages[4]
    assert messages[1]['records']==[{'code':'US.AAPL','close':12.5,'unknown':None}]
    assert messages[1]['nextCursor']==base64.b64encode(b'provider-next').decode()


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
    def configured(db, *, reuse_latest=False, reuse_history=False):
        assert reuse_latest is True and reuse_history is True
        return object(),lane
    async def cycle(*args,allow_history=True):
        assert allow_history is False
        stop.set()
        if state=='database_unavailable':raise RuntimeError('controlled unavailable')
    async def public(*args):pass
    async def history(*args):return False
    monkeypatch.setattr(market_runtime,'from_settings',configured)
    monkeypatch.setattr(market_runtime,'batch_cycle',cycle)
    monkeypatch.setattr(market_runtime,'history_cycle',history)
    monkeypatch.setattr(public_market_worker,'cycle',public)
    async with asyncio.timeout(3):
        await market_runtime.loop(object(),stop,current=lambda:state!='retired')
    assert lane.closed==(2 if state=='retired' else 1) and lane.retired==1


@pytest.mark.parametrize('blocked_lane',['latest','history'])
async def test_history_and_latest_progress_independently_with_one_history_child_and_owned_cleanup(monkeypatch,blocked_lane):
    from alcor_api import market_runtime, public_market_worker
    stop=asyncio.Event()
    entered,progress=asyncio.Event(),asyncio.Event()
    running=maximum=completed=0
    cancelled=[]

    class Lane:
        closed=0
        async def close(self):self.closed+=1
        async def retire_idle(self):pass
    lane=Lane()

    async def history(*args):
        nonlocal running,maximum,completed
        running+=1;maximum=max(maximum,running)
        try:
            if blocked_lane=='history':
                entered.set()
                try:await asyncio.Event().wait()
                finally:cancelled.append('history')
            else:
                await entered.wait()
                completed+=1
                if completed==2:progress.set()
                return True
        finally:running-=1

    async def latest(*args,allow_history=True):
        assert allow_history is False
        if blocked_lane=='latest':
            entered.set()
            await progress.wait()
        else:
            await entered.wait()
            progress.set()
        stop.set()
        return True

    async def public(*args):pass
    monkeypatch.setattr(market_runtime,'from_settings',lambda *args,**kwargs:(object(),lane))
    monkeypatch.setattr(market_runtime,'history_cycle',history)
    monkeypatch.setattr(market_runtime,'batch_cycle',latest)
    monkeypatch.setattr(public_market_worker,'cycle',public)
    async with asyncio.timeout(2):await market_runtime.loop(object(),stop)
    assert progress.is_set() and maximum==1 and running==0 and lane.closed==1
    assert completed>=2 if blocked_lane=='latest' else cancelled==['history']
