"""Pinned installed Agent protocol; no discovery, redirects or implicit model delegation."""
import asyncio
import hashlib
import json
import re
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpcore
from fastapi import HTTPException

from .fx_provider_transport import PinnedBackend, resolve
from .provider_setting_transport import approved_model_target

LIMIT=2097152
ACTIONS={'probe','start','query','continue','stop','config-read','config-write'}


def encoded(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()


def fingerprint(value):return hashlib.sha256(encoded(value)).hexdigest()


def validate(value,owner,instance):
    if not isinstance(value,dict) or set(value)-{'name','url','approval','agentInstanceId','token'}:raise HTTPException(422,'Agent连接字段无效')
    if not isinstance(value.get('url'),str):raise HTTPException(422,'Agent入口须为文字')
    parsed=urlsplit(value['url'])
    if parsed.query or parsed.fragment or parsed.username or parsed.password or len(parsed.path)>128 or parsed.path and not re.fullmatch(r'(?:/[A-Za-z0-9_-]+)*/?',parsed.path):raise HTTPException(422,'Agent须为固定独立入口')
    approval=value.get('approval',{})
    if not isinstance(approval,dict) or set(approval)-{'host','port','path','addresses','approvedAccess','licenseRevision','expiresAt','ownerId','instanceId','purposes','allowPrivate','allowPlaintext'}:raise HTTPException(422,'Agent批准字段无效')
    try:
        if approval.get('ownerId')!=str(owner) or approval.get('instanceId')!=str(instance) or approval.get('approvedAccess') is not True or 'agent.runtime' not in approval.get('purposes',[]) or not approval.get('licenseRevision'):raise ValueError()
        expiry=datetime.fromisoformat(approval['expiresAt'])
        if expiry.tzinfo is None or expiry<=datetime.now(UTC):raise ValueError()
        approved_model_target(value['url'],approval,approval['addresses'])
        if not isinstance(value.get('name'),str) or not 1<=len(value['name'])<=100:raise ValueError()
        if not isinstance(value.get('agentInstanceId',''),str) or len(value.get('agentInstanceId',''))>180:raise ValueError()
        if not isinstance(value.get('token',''),str) or not value.get('token') or len(value['token'])>8192 or any(c in value['token'] for c in '\r\n\0'):raise ValueError()
    except (ValueError,TypeError,KeyError):raise HTTPException(422,'Agent目标、固定地址或当前许可无效') from None
    return value


async def read(target,method,path,payload,authorize):
    if not path.startswith('/v1/') or '?' in path or '..' in path:raise ValueError('agent_protocol_path')
    parsed=urlsplit(target['url']);approval=target['approval'];host=parsed.hostname;port=parsed.port or (443 if parsed.scheme=='https' else 80)
    async with asyncio.timeout(35):
        pins=approved_model_target(target['url'],approval,await resolve(host,port))
        await authorize()
        headers={'Authorization':'Bearer '+target['token'],'Content-Type':'application/json','Accept-Encoding':'identity'}
        if target.get('agentInstanceId'):headers['X-Alcor-Agent-Instance']=target['agentInstanceId']
        async with httpcore.AsyncConnectionPool(network_backend=PinnedBackend(host,port,pins[0]),retries=0,max_connections=1) as pool,pool.stream(method,target['url'].rstrip('/')+path,headers=headers,content=encoded(payload) if payload is not None else None,extensions={'timeout':{'connect':5,'read':30,'write':10,'pool':5}}) as response:
            raw=bytearray();complete=True
            async for chunk in response.aiter_stream():
                remaining=LIMIT-len(raw);raw.extend(chunk[:remaining])
                if len(chunk)>remaining:complete=False;break
            return {'raw':bytes(raw),'status':response.status,'complete':complete}
