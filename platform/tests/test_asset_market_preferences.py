from test_account_preferences import appearance


async def test_market_order_is_account_preference_with_revision_and_strict_codes(client, admin):
    current = (await client.get('/api/account/preferences')).json()
    style = appearance()
    style['assetMarketOrder'] = ['HK', 'US', *style['assetMarketOrder'][2:]]
    changed = await client.patch('/api/account/preferences', json={'revision': current['revision'], 'appearance': style})
    assert changed.status_code == 200, changed.text
    saved = changed.json()
    assert saved['appearance']['assetMarketOrder'] == style['assetMarketOrder']
    assert (await client.get('/api/account/preferences')).json() == saved
    assert (await client.patch('/api/account/preferences', json={'revision': current['revision'], 'appearance': style})).status_code == 409
    older = {**style, 'mode': 'light'}
    older.pop('assetMarketOrder')
    legacy = await client.patch('/api/account/preferences', json={'revision': saved['revision'], 'appearance': older})
    assert legacy.status_code == 200, legacy.text
    saved = legacy.json()
    assert saved['appearance']['assetMarketOrder'] == style['assetMarketOrder']
    for invalid in [['US', 'US'], ['US', 'SPX'], ['not a market'], []]:
        bad = {**style, 'assetMarketOrder': invalid}
        assert (await client.patch('/api/account/preferences', json={'revision': saved['revision'], 'appearance': bad})).status_code == 422

async def test_broker_order_is_private_versioned_and_preserved_for_older_clients(client, admin):
    style=appearance()
    style['assetBrokerOrder']=['broker:HK:ONE','broker:US:ONE']
    result=await client.patch('/api/account/preferences',json={'revision':None,'appearance':style})
    assert result.status_code==200,result.text
    saved=result.json()
    old={**style};old.pop('assetBrokerOrder')
    result=await client.patch('/api/account/preferences',json={'revision':saved['revision'],'appearance':old})
    assert result.status_code==200,result.text
    assert result.json()['appearance']['assetBrokerOrder']==style['assetBrokerOrder']
    for invalid in [['x','x'],['../private'],['a'*121]]:
        bad={**style,'assetBrokerOrder':invalid}
        assert (await client.patch('/api/account/preferences',json={'revision':result.json()['revision'],'appearance':bad})).status_code==422
