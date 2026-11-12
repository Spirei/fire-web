"""High-frequency quote intent cannot hold the account's exclusive identity lock."""

import asyncio

from alcor_api.market_authority import Authority
from market_subscription_candidate.test_subscriptions import native


async def test_native_quote_observation_allows_parallel_account_reads_but_keeps_current_authorization(market,monkeypatch):
    client,app,_authority,_transport,revision=market
    headers,_=await native(app)
    headers['x-alcor-market-source']=revision
    entered,release=asyncio.Event(),asyncio.Event()
    demand=Authority.demand

    async def paused(self,*args,**kwargs):
        if kwargs.get('observed'):
            entered.set()
            await release.wait()
        return await demand(self,*args,**kwargs)

    monkeypatch.setattr(Authority,'demand',paused)
    observation=asyncio.create_task(client.post('/api/v2/quotes',headers=headers,
        json={'items':[{'id':'held','market':'US','code':'AAPL'}]}))
    try:
        async with asyncio.timeout(3):await entered.wait()
        async with asyncio.timeout(3):
            responses=await asyncio.gather(*(client.get('/api/v2/'+path,headers=headers)
                for path in ('account-sync','account-assets','records')))
        assert all(response.status_code==200 for response in responses),[r.text for r in responses]
        assert not observation.done()
    finally:
        release.set()
        await asyncio.gather(observation,return_exceptions=True)
    assert observation.result().status_code==200,observation.result().text
