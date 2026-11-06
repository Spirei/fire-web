"""One explicit fixed-target request, DNS pinned; no retry, redirect or polling."""

import asyncio

import httpcore

from .fx_provider_parser import approved_target
from .fx_provider_transport import PinnedBackend, resolve
from .market_discovery_protocol import LIMIT


class PageFailure(ValueError):
    def __init__(self,raw,status,complete,headers=None):
        super().__init__('discovery_page_failed')
        self.raw,self.status,self.complete,self.headers=raw,status,complete,headers or {}


class Transport:
    async def read(self,target,value):
        method,url,body,approval=target.request(value)
        approved_target(url,approval,approval['addresses'])
        async with asyncio.timeout(15):
            pins=approved_target(url,approval,await resolve(target.host,443))
            headers={'User-Agent':'Alcor market discovery/1','Accept-Encoding':'identity'}
            if body is not None:headers.update({'Content-Type':'application/json','Origin':'https://www.tradingview.com'})
            if target.source=='cnn':headers.update({'Origin':'https://edition.cnn.com','Referer':'https://edition.cnn.com/markets/fear-and-greed'})
            async with (httpcore.AsyncConnectionPool(network_backend=PinnedBackend(target.host,443,pins[0]),retries=0,max_connections=1) as pool,
                        pool.stream(method,url,content=body,headers=headers,extensions={'timeout':{'connect':5,'read':8,'write':5,'pool':5}}) as response):
                metadata={key.decode('ascii').lower():value.decode('latin1') for key,value in response.headers if key.lower() in (b'content-type',b'content-encoding',b'date')}
                raw=bytearray()
                async for chunk in response.aiter_stream():
                    raw.extend(chunk)
                    if len(raw)>LIMIT:raise PageFailure(bytes(raw[:LIMIT]),response.status,False,metadata)
                if response.status!=200 or metadata.get('content-encoding','identity')!='identity':
                    raise PageFailure(bytes(raw),response.status,True,metadata)
                return bytes(raw),response.status,metadata
