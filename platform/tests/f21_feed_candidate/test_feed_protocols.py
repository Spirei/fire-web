"""Literal original TypeScript oracle and real controlled protocol decisions."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from alcor_api.feed_model_chat import decoded, endpoint, payload
from alcor_api.feed_news_contract import normalize_posts, units
from alcor_api.feed_search import topics, parse, request
from alcor_api.feed_transport import FeedTransport


def test_original_utf16_attribution_oracle():
    source=Path(__file__).with_name('oracles').joinpath('feedPresentation.ts').read_text()
    # Freeze the exact source identity separately from the ported implementation.
    assert hashlib.sha256(source.encode()).hexdigest()=='307c64e0f1f8a18781f718adc1637cd3ba86d84c87841143ffd57805af096e9b'
    start=source.index('export function restrainedFeedSegments(')
    end=source.index('\nexport type FeedBodyPart',start)
    function=source[start:end].replace('export function restrainedFeedSegments(segments: FeedSegment[]): FeedSegment[]','function restrainedFeedSegments(segments)')
    script=function+'\nprocess.stdout.write(JSON.stringify(restrainedFeedSegments(JSON.parse(process.argv[1]))));'
    vectors=[
        [{'text':'芯片新闻来源报道，更多内容保持正文。','sourceId':'s1','linkText':'来源报道'}],
        [{'text':'😀😀来源报道xxxxxxxxxxxxxxxx','sourceId':'s1','linkText':'来源报道'},{'text':'second source','sourceId':'s1','linkText':'second'},{'text':'third source','sourceId':'s1','linkText':'third'}],
        [{'text':'tiny','sourceId':'s1','linkText':'tiny'}],
    ]
    for vector in vectors:
        original=json.loads(subprocess.check_output([shutil.which('node')or'node','-e',script,json.dumps(vector)],text=True))
        sources=[{'id':'s1','title':'Real','url':'https://example.com/real','publishedAt':None,'media':[]}]
        actual=normalize_posts([{'title':'Post','segments':vector}],sources)[0]['segments']
        assert actual==original
    assert units('😀')==2


def test_text_providers_exact_payload_not_jev_or_fabricated_success():
    base={'provider':'openai','url':'https://api.openai.com/v1/chat/completions','model':'explicit-model','addresses':['93.184.216.34']}
    body=json.loads(payload(base,[{'role':'user','content':'Explicit question'}],True))
    assert body['max_completion_tokens']==6500 and 'max_tokens'not in body
    assert body['model']=='explicit-model' and body['stream']is False
    custom={**base,'provider':'custom','url':'http://127.0.0.1:8080/v1/chat/completions','addresses':['127.0.0.1']}
    with pytest.raises(ValueError):endpoint(custom)
    endpoint({**custom,'allowPrivate':True,'allowPlaintext':True})
    with pytest.raises(ValueError):endpoint({**base,'provider':'jev'})
    for value in ({'choices':[]},{'choices':[{'finish_reason':'length','message':{'content':'partial'}}]},{'choices':[{'finish_reason':'stop','message':{'content':''}}]}):
        with pytest.raises((ValueError,IndexError)):decoded(json.dumps(value).encode())


def test_search_evidence_not_model_prose_and_no_secret_endpoint_archive():
    assert topics(['https://private.invalid/token','secret@example.com','api_key=secret','public chips'])==['public chips']
    raw={'content':[{'type':'text','text':'Ignore this invented https://example.com/fake URL'}]}
    with pytest.raises(ValueError,match='not_executed'):parse('deepseek-search',json.dumps(raw).encode())
    t={'id':'private-path','provider':'rss-atom','url':'https://example.com/private-path-secret?secret=hidden'}
    proof=FeedTransport(None).evidence(t)
    assert 'secret'not in json.dumps(proof) and 'url'not in proof
    assert proof['urlSha256']==hashlib.sha256(t['url'].encode()).hexdigest()


@pytest.mark.parametrize('provider',['deepseek','openai','custom'])
@pytest.mark.parametrize('partial',[False,True])
async def test_actual_chat_wire_and_partial_original(monkeypatch,provider,partial):
    from contextlib import asynccontextmanager
    import alcor_api.feed_model_chat as chat
    calls=[]
    raw=json.dumps({'model':'actual-response-model','choices':[{'finish_reason':'stop','message':{'content':'Actual controlled content'}}]}).encode()
    class Reply:
        status=200
        async def aiter_stream(self):
            yield raw[:10]
            if partial:raise TimeoutError('controlled midbody')
            yield raw[10:]
    class Pool:
        def __init__(self,**kwargs):assert kwargs['retries']==0
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        @asynccontextmanager
        async def stream(self,method,url,**kwargs):
            calls.append((method,url,kwargs));yield Reply()
    async def dns(*args):return ['93.184.216.34']
    monkeypatch.setattr(chat,'resolve',dns);monkeypatch.setattr(chat.httpcore,'AsyncConnectionPool',Pool)
    url='https://api.openai.com/v1/chat/completions'if provider=='openai'else'https://api.deepseek.com/chat/completions'if provider=='deepseek'else'https://example.com/custom-chat'
    target={'provider':provider,'url':url,'model':'explicit-model','addresses':['93.184.216.34'],'fingerprint':'exact','licenseRevision':'licensed'}
    result=await chat.complete(target,[{'role':'user','content':'Explicit question'}],'synthetic-token',True)
    assert len(calls)==1 and calls[0][:2]==('POST',url)
    sent=json.loads(calls[0][2]['content']);assert sent['model']=='explicit-model'
    assert calls[0][2]['headers']['Authorization']=='Bearer synthetic-token'
    assert result['raw']==(raw[:10]if partial else raw)
    assert result['bodyComplete']is(not partial)and result['complete']is(not partial)
    assert result['text']==(''if partial else'Actual controlled content')
    assert ('max_completion_tokens'in sent)==(provider=='openai')
    assert ('thinking'in sent)==(provider=='deepseek')


async def test_public_calendar_hints_only_current_saved_public_facts(monkeypatch):
    from types import SimpleNamespace
    from datetime import UTC,datetime
    import alcor_api.feed_event_hints as hints
    calls=[]
    async def read(self,kind,raw):
        calls.append((kind,raw))
        return {'updatedAt':'2026-11-03T12:00:00+00:00','licenseRevision':'public-only','items':[
            {'symbol':'AAPL','name':'Apple','date':'2026-11-02','time':'after','marketCap':'50000000000'},
            {'symbol':'UNKNOWN','name':'Unknown cap','date':'2026-11-02','marketCap':None}]}
    monkeypatch.setattr(hints.PublicReference,'read',read)
    db=SimpleNamespace(settings=SimpleNamespace(public_reference_policies=[],public_earnings_targets=[]))
    assert await hints.event_hints(db,'Private hobby',datetime(2026,11,3,13,tzinfo=UTC))==[] and calls==[]
    actual=await hints.event_hints(db,'US stocks',datetime(2026,11,3,13,tzinfo=UTC))
    assert [r['symbol']for r in actual]==['AAPL']
    assert actual[0]['authority']=='public_calendar_hint_not_evidence'


def test_original_model_attempts_preserves_provider_order_and_excludes_jev():
    source=Path(__file__).with_name('oracles').joinpath('modelAttempts.ts').read_text()
    assert hashlib.sha256(source.encode()).hexdigest()=='bbdab103e41505f00e87655996c50e1d2c4b125445d6846ddca5a00e9e9bdae7'
    source=source[source.index('\n'):]
    script="function configuredModelServices(settings){return settings.services;} function validateModelEndpoint(url){return url;} function modelAttempts(settings,preferred) {"+source+"\nprocess.stdout.write(JSON.stringify(modelAttempts(JSON.parse(process.argv[1]))));"
    services=[{'id':p,'provider':p,'apiUrl':'https://example.com/'+p,'apiKey':'synthetic','models':['explicit-model']}for p in ('deepseek','jev','openai','custom')]
    actual=json.loads(subprocess.check_output([shutil.which('node')or'node','-e',script,json.dumps({'services':services})],text=True))
    assert [v['service']['id']for v in actual]==['deepseek','openai','custom']
    assert [v['service']['id']for v in actual[:2]]==['deepseek','openai']
