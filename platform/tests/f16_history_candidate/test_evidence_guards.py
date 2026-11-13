"""Read evidence cannot acquire a different time or turn a failed page into data."""
from dataclasses import asdict
from copy import deepcopy
from datetime import datetime
from hashlib import sha256
from types import SimpleNamespace
from uuid import uuid4

import pytest
from alcor_api.market_contract import Query, canonical, digest, series_fingerprint
from alcor_api.market_history_evidence import verify_history_rows
from alcor_api.market_worker import decode
from fastapi import HTTPException


@pytest.mark.parametrize('failure',['time_mismatch','naive_time','http_failure','incomplete','duplicate'])
async def test_evidence_time_and_complete_original_guards(failure):
    owner,revision,stream,page_id = 'synthetic',uuid4(),uuid4(),uuid4()
    query = Query('bars','US','AAPL','day','qfq',start='2026-10-20',through='2026-10-21')
    policy = SimpleNamespace(source='controlled',source_version='v1',fixture=True,license_revision='synthetic')
    raw_fact = {'at':'2026-10-20T14:00:00+00:00','o':'10','h':'12','l':'9','c':'11','session':'REGULAR','currency':'USD'}
    raw = canonical({'query':asdict(query),'licenseRevision':'synthetic','facts':[raw_fact]*(2 if failure=='duplicate' else 1)}).encode()
    decoded,_,_ = decode(policy,query,raw)
    contents = decoded[0]
    fact = {'page_id':page_id,'stream_id':stream,'series_fingerprint':series_fingerprint(query),'source_revision':revision,
            'contents':contents,'fingerprint':digest(contents),'source_time':datetime.fromisoformat(contents['at'])}
    page = {'task_owner':owner,'stream_revision':revision,'raw_bytes':raw,'raw_sha256':sha256(raw).hexdigest(),
            'source_query':asdict(query),'source_stream_id':stream,'cursor_in':None,'issues':[]}
    if failure == 'time_mismatch':fact['source_time'] = datetime.fromisoformat('2026-10-21T14:00:00+00:00')
    if failure == 'naive_time':fact['contents'] = {**contents,'at':'2026-10-20T14:00:00'}
    if failure == 'http_failure':page['issues'] = [{'reason':'source_http_or_size_error','httpStatus':503,'complete':True}]
    if failure == 'incomplete':page['complete'] = False
    class Connection:
        async def execute(self,*args):return self
        async def fetchone(self):return page
    with pytest.raises(HTTPException) as rejected:
        await verify_history_rows(Connection(),owner,revision,[fact],policy)
    assert rejected.value.status_code == 503


@pytest.mark.parametrize('failure',[None,'oversize','missing','tampered','wrong_owner'])
async def test_32_pages_share_bounded_original_reads_without_skipping_any_proof(failure):
    owner,revision,stream='synthetic',uuid4(),uuid4()
    query=Query('bars','US','AAPL','day','qfq',start='2026-10-20',through='2026-10-21')
    policy=SimpleNamespace(source='controlled',source_version='v1',fixture=True,license_revision='synthetic')
    raw=canonical({'query':asdict(query),'licenseRevision':'synthetic','facts':[
        {'at':'2026-10-20T14:00:00+00:00','o':'10','h':'12','l':'9','c':'11','session':'REGULAR','currency':'USD'}]}).encode()
    contents=decode(policy,query,raw)[0][0]
    pages=[];facts=[]
    for _ in range(32):
        identifier=uuid4()
        facts.append({'page_id':identifier,'stream_id':stream,'series_fingerprint':series_fingerprint(query),
            'source_revision':revision,'contents':contents,'fingerprint':digest(contents),
            'source_time':datetime.fromisoformat(contents['at'])})
        pages.append({'id':identifier,'task_owner':owner,'stream_revision':revision,'raw_bytes':raw,
            'raw_sha256':sha256(raw).hexdigest(),'source_query':asdict(query),
            'source_stream_id':stream,'cursor_in':None,'issues':[]})
    if failure=='missing':pages.pop()
    if failure=='tampered':pages[-1]['raw_bytes']=raw+b' '
    if failure=='wrong_owner':pages[-1]['task_owner']='other-owner'
    class Connection:
        calls=0
        async def execute(self,statement,parameters):
            self.calls+=1
            assert owner in parameters and revision in parameters
            return self
        async def fetchone(self):return {'bytes':64*1024*1024+1 if failure=='oversize' else sum(len(p['raw_bytes']) for p in pages)}
        async def fetchall(self):
            assert failure!='oversize','Oversized bodies must not be loaded'
            return pages
    connection=Connection()
    if failure:
        with pytest.raises(HTTPException) as rejected:
            await verify_history_rows(connection,owner,revision,facts,policy)
        assert rejected.value.status_code==503
    else:
        await verify_history_rows(connection,owner,revision,facts,policy)
    assert connection.calls==(1 if failure=='oversize' else 2)


@pytest.mark.parametrize('change', ['body', 'duplicate', 'fact', 'query', 'cursor', 'license', 'owner'])
async def test_warm_decoded_index_never_authorizes_changed_original_or_reference(change):
    owner,revision,stream='synthetic',uuid4(),uuid4()
    query=Query('bars','US','AAPL','day','qfq',start='2026-10-20',through='2026-10-21')
    policy=SimpleNamespace(source='controlled',source_version='v1',fixture=True,license_revision='synthetic')
    original={'at':'2026-10-20T14:00:00+00:00','o':'10','h':'12','l':'9','c':'11','session':'REGULAR','currency':'USD'}
    envelope={'query':asdict(query),'licenseRevision':'synthetic','facts':[original]}
    raw=canonical(envelope).encode()
    contents=decode(policy,query,raw)[0][0]
    fact={'page_id':uuid4(),'stream_id':stream,'series_fingerprint':series_fingerprint(query),
        'source_revision':revision,'contents':contents,'fingerprint':digest(contents),
        'source_time':datetime.fromisoformat(contents['at'])}
    page={'task_owner':owner,'stream_revision':revision,'raw_bytes':raw,'raw_sha256':sha256(raw).hexdigest(),
        'source_query':asdict(query),'source_stream_id':stream,'cursor_in':None,'issues':[]}
    class Connection:
        async def execute(self,*args):return self
        async def fetchone(self):return page
    await verify_history_rows(Connection(),owner,revision,[fact],policy)
    if change=='body':page['raw_bytes']=raw+b' '
    elif change=='duplicate':
        envelope['facts'].append(deepcopy(original))
        page['raw_bytes']=canonical(envelope).encode()
        page['raw_sha256']=sha256(page['raw_bytes']).hexdigest()
    elif change=='fact':fact['contents']={**contents,'c':'10'};fact['fingerprint']=digest(fact['contents'])
    elif change=='query':page['source_query']={**page['source_query'],'code':'MSFT'}
    elif change=='cursor':page['cursor_in']='different-cursor'
    elif change=='license':policy.license_revision='different-license'
    elif change=='owner':page['task_owner']='different-owner'
    # Controlled fixtures do not interpret cursor input, but it must miss the
    # old index. Use the installed source decoder's scope guard for this case.
    if change=='cursor':
        import alcor_api.market_history_evidence as evidence
        original_decode=evidence.decode
        def reject_changed_cursor(*args,**kwargs):
            if kwargs.get('cursor_in')=='different-cursor':raise ValueError('cursor_scope_changed')
            return original_decode(*args,**kwargs)
        from unittest.mock import patch
        with patch.object(evidence,'decode',reject_changed_cursor), pytest.raises(HTTPException):
            await verify_history_rows(Connection(),owner,revision,[fact],policy)
    else:
        with pytest.raises(HTTPException) as rejected:
            await verify_history_rows(Connection(),owner,revision,[fact],policy)
        assert rejected.value.status_code==503
