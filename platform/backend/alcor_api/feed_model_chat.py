"""Installed text-model protocol for F21; no tools, defaults or provider fallback."""
import asyncio
import json
from urllib.parse import urlsplit

import httpcore

from .fx_provider_parser import unique
from .fx_provider_transport import PinnedBackend,resolve
from .provider_setting_transport import approved_model_target

LIMIT=1_000_000


def endpoint(raw):
    provider=raw['provider']
    if provider not in {'deepseek','openai','custom'}:raise ValueError('feed_text_provider_unsupported')
    url=raw.get('url') or raw.get('apiUrl')
    if not url:
        if provider!='deepseek':raise ValueError('feed_model_endpoint_required')
        url='https://api.deepseek.com/chat/completions'
    parsed=urlsplit(url)
    port=parsed.port or (443 if parsed.scheme=='https' else 80)
    if parsed.query or parsed.fragment or parsed.username or parsed.password or not parsed.hostname or not parsed.path:
        raise ValueError('feed_model_endpoint_invalid')
    approval={**raw.get('approval',{}),'host':raw.get('host',parsed.hostname),'port':raw.get('port',port),
        'path':raw.get('path',parsed.path),'addresses':raw['addresses'],
        'allowPrivate':raw.get('allowPrivate',raw.get('approval',{}).get('allowPrivate',False)),
        'allowPlaintext':raw.get('allowPlaintext',raw.get('approval',{}).get('allowPlaintext',False))}
    approved_model_target(url,approval,raw['addresses'])
    return url,approval


def payload(target,messages,structured=False):
    if not isinstance(messages,list) or not 1<=len(messages)<=16:raise ValueError('feed_context_invalid')
    for m in messages:
        if not isinstance(m,dict) or set(m)!={'role','content'} or m['role']not in {'system','user','assistant'} or not isinstance(m['content'],str) or not 1<=len(m['content'])<=120000:
            raise ValueError('feed_context_invalid')
    body={'model':target['model'],'messages':messages,'stream':False}
    body['max_completion_tokens'if target['provider']=='openai'else'max_tokens']=6500 if structured else 3500
    if target['provider']!='openai':body['temperature']=0.2
    url,_=endpoint(target)
    if target['provider']=='deepseek'and urlsplit(url).hostname=='api.deepseek.com':
        body['thinking']={'type':'disabled'}
        if structured:body['response_format']={'type':'json_object'}
    data=json.dumps(body,ensure_ascii=False,allow_nan=False).encode()
    if len(data)>131072:raise ValueError('feed_context_budget')
    return data


def decoded(raw):
    value=json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in()).throw(ValueError()))
    choice=value['choices'][0];text=choice['message']['content']
    if choice.get('finish_reason')!='stop'or not isinstance(text,str)or not text.strip()or len(text)>100000:
        raise ValueError('feed_reply_unconfirmed')
    return text.strip(),value.get('model')if isinstance(value.get('model'),str)else None


async def complete(target,messages,token,structured=False):
    url,approval=endpoint(target);parsed=urlsplit(url);port=parsed.port or(443 if parsed.scheme=='https' else 80)
    content=payload(target,messages,structured)
    result=None;output=bytearray()
    try:
        async with asyncio.timeout(23):
            pins=approved_model_target(url,approval,await resolve(parsed.hostname,port))
            async with httpcore.AsyncConnectionPool(network_backend=PinnedBackend(parsed.hostname,port,pins[0]),retries=0,max_connections=1)as pool:
                async with pool.stream('POST',url,headers={'Content-Type':'application/json','Authorization':'Bearer '+token,'Accept-Encoding':'identity'},content=content,
                    extensions={'timeout':{'connect':5,'read':20,'write':5,'pool':3}})as response:
                    result={'raw':b'','status':response.status,'bodyComplete':False,'complete':False,'text':'',
                        'requestedModel':target['model'],'responseModel':None,'licenseRevision':target['licenseRevision'],'fingerprint':target['fingerprint']}
                    async for chunk in response.aiter_stream():
                        remaining=LIMIT-len(output);output.extend(chunk[:remaining])
                        if len(chunk)>remaining:break
                    else:result['bodyComplete']=True
    except (Exception,asyncio.CancelledError):
        if result is None:raise
        # An issued reply prefix is history, even if the source later times out.
    result['raw']=bytes(output)
    if result['bodyComplete']and result['status']==200:
        try:result['text'],result['responseModel']=decoded(result['raw']);result['complete']=True
        except (ValueError,TypeError,KeyError,IndexError):pass
    return result
