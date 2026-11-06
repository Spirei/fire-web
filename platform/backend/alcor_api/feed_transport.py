"""One installed pinned F21 request; no redirects, discovery or automatic retry."""
import asyncio
import json
from datetime import UTC,datetime
from urllib.parse import parse_qs,urlsplit

import httpcore
from cryptography.fernet import Fernet

from .feed_parse import LIMIT,public_url
from .fx_provider_parser import approved_target
from .fx_provider_transport import PinnedBackend,resolve
from .notification_security import NotificationSecurity


class Response:
    def __init__(self,raw,status,complete=True,content_type=None):
        self.raw,self.status,self.complete,self.content_type=raw,status,complete,content_type


class FeedTransport:
    def __init__(self,db):self.db=db

    def specification(self,target,params=None):
        if target['provider']in {'deepseek-search','brave-search','google-news-rss','publisher-html'}:
            from .feed_search import request
            return request(target,params or{})
        return {'url':target['url'],'method':'GET','headers':{},'body':None}

    def evidence(self,target,params=None):
        # Installed paths/queries may themselves contain credentials. Keep their
        # identity as a digest, never copy the private endpoint into admissions.
        import hashlib
        spec=self.specification(target,params)
        return {"method":spec["method"],"urlSha256":hashlib.sha256(spec["url"].encode()).hexdigest(),
            "body":spec["body"],"targetId":target["id"],"provider":target["provider"]}

    async def read(self,target,*,params=None):
        if target['approvedAccess']is not True or datetime.fromisoformat(target['expiresAt'])<=datetime.now(UTC):raise ValueError('feed_target_not_approved')
        spec=self.specification(target,params);url=public_url(spec['url'])
        if not url:raise ValueError('feed_target_not_public')
        parsed=urlsplit(url)
        if any(k.lower()in {'token','key','secret','password','authorization','apikey','api_key','access_token'}for k in parse_qs(parsed.query)):raise ValueError('feed_url_credentials_forbidden')
        approval={'target':['https',parsed.hostname,443,parsed.path or'/'],'addresses':target['addresses'],'allow_plaintext':False}
        provider=target['provider']
        headers={'User-Agent':'AlcorFeed/1','Accept-Encoding':'identity','Accept':'text/html'if provider=='publisher-html'else'application/json'if provider in {'person-original-json','xueqiu-status-json','deepseek-search','brave-search'}else'application/rss+xml, application/atom+xml, application/xml, text/xml',**spec['headers']}
        if spec['body']is not None:headers['Content-Type']='application/json'
        if target.get('credentialCiphertext'):
            value=json.loads(Fernet(NotificationSecurity(self.db).existing_key()).decrypt(target['credentialCiphertext'].encode()))
            if value['kind']!='feed-source:'+target['id']or str(value['instance'])!=str(self.db.settings.instance_id):raise ValueError('feed_credential_binding_invalid')
            token=value['password']
            if not isinstance(token,str)or not token or any(c in token for c in '\r\n\0'):raise ValueError('feed_credential_invalid')
            if provider=='xueqiu-status-json':
                if value.get('host')!='api.xueqiu.com':raise ValueError('feed_cookie_host_invalid')
                headers.update(Cookie=token,Referer='https://xueqiu.com/u/slowisquick',Origin='https://xueqiu.com')
            elif provider=='brave-search':headers['X-Subscription-Token']=token
            elif provider=='deepseek-search':headers.update({'x-api-key':token,'Authorization':'Bearer '+token})
            else:headers['Authorization']='Bearer '+token
        content=json.dumps(spec['body'],ensure_ascii=True,allow_nan=False).encode()if spec['body']is not None else None
        if content is not None and len(content)>131072:raise ValueError('feed_request_budget')
        result=None;body=bytearray()
        try:
            async with asyncio.timeout(23 if provider=='deepseek-search' else 15):
                pins=approved_target(url,approval,await resolve(parsed.hostname,443))
                async with httpcore.AsyncConnectionPool(network_backend=PinnedBackend(parsed.hostname,443,pins[0]),retries=0,max_connections=1)as pool:
                    async with pool.stream(spec['method'],url,headers=headers,content=content,extensions={'timeout':{'connect':5,'read':20 if provider=='deepseek-search' else 5,'write':5,'pool':5}})as response:
                        mime=next((v.decode('latin1').split(';')[0].strip().lower()for k,v in response.headers if k.lower()==b'content-type'),None)
                        result=Response(b'',response.status,False,mime)
                        async for chunk in response.aiter_stream():
                            remaining=LIMIT-len(body);body.extend(chunk[:remaining])
                            if len(chunk)>remaining:break
                        else:result.complete=True
        except (Exception,asyncio.CancelledError):
            if result is None:raise
            # Preserve an issued bounded reply prefix even after timeout/cancel.
        result.raw=bytes(body)
        return result
