"""Legacy analysis reads preserve evidence gaps and never collect or execute."""
import pytest
from test_trading import setup, command, submit
from test_legacy_trade_corrections import native_headers


@pytest.mark.parametrize('version', [1, 2])
async def test_overview_missing_quotes_and_mixed_books(client, admin, db, version):
    _, record = await setup(client)
    filled, _ = await submit(client, command(record))
    headers = await native_headers(db, admin)
    response = await client.get(f'/api/v{version}/overview', headers=headers)
    assert response.status_code == 200, response.text
    data = response.json()['data']
    assert data['totalMarket'] is None and data['totalAsset'] is None
    assert data['complete'] is False and data['totalCash'] == 979
    assert data['unconverted'] == [record['id']]
    assert data['quoteStatus'] == {'pending':False,'cached':[],'missing':[record['id']]}
    assert data['cashComplete'] is True and data['totalAssetComplete'] is False
    assert data['migration']['collectionOnRead'] is False
    assert data['migration']['unknownValuesRemainNull'] is True
    assert data['count'] == 1
    await setup(client, account_kind='simulated', name='Separate simulation', code='MSFT')
    denied = await client.get(f'/api/v{version}/overview', headers=headers)
    assert denied.status_code == 409, denied.text
    assert filled['brokerExecution'] is False


async def test_series_effective_evidence_etag_and_no_fabricated_history(client, admin, db):
    _, record = await setup(client)
    fill, _ = await submit(client, command(record))
    headers = await native_headers(db, admin)
    response = await client.get('/api/v1/portfolio-series?days=0', headers=headers)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['days'] == 330 and value['closes'] == {}
    assert len(value['orders']) == 1 and value['orders'][0]['id'] == fill['tradeId']
    assert value['orders'][0]['side'] == 'buy'
    assert value['migration']['materialBundleNotHistoricalAssetCurve'] is True
    analysis = value['migration']['periodAnalysis']
    assert analysis['completePeriodReturn']['dailyAssetCurve'] is None
    assert analysis['observedSubtotalsAreCompleteAccountReturn'] is False
    etag = response.headers['etag']
    unchanged = await client.get('/api/v1/portfolio-series?days=0', headers={**headers, 'if-none-match': etag})
    assert unchanged.status_code == 304 and unchanged.content == b''
    await submit(client, command(fill['record'], occurredAt='2026-01-03T00:00:00Z'))
    changed = await client.get('/api/v1/portfolio-series?days=0', headers={**headers, 'if-none-match': etag})
    assert changed.status_code == 200 and changed.headers['etag'] != etag
    await client.post('/api/auth/logout')
    other = await client.post('/api/auth/register', json={'username':'AnalysisOther','password':'SyntheticAnalysisPass9'})
    assert other.status_code == 201, other.text
    other_headers = await native_headers(db, other.json()['user']['id'])
    isolated = await client.get('/api/v1/portfolio-series?days=0', headers={**other_headers, 'if-none-match':etag})
    assert isolated.status_code == 200 and isolated.json()['orders'] == []
    assert isolated.json()['closes'] == {} and isolated.headers['etag'] != etag


@pytest.mark.parametrize('path', ['/api/v1/overview', '/api/v2/overview', '/api/v1/portfolio-series'])
async def test_supplied_bad_credentials_never_fall_back_to_web_cookie(client, admin, path):
    for headers in ({'authorization': ''}, {'authorization': 'Bearer '}, [('authorization', 'Bearer first'), ('authorization', 'Bearer second')]):
        response = await client.get(path, headers=headers)
        assert response.status_code == 401, response.text
        assert response.headers['x-alcor-retire-context'] == 'true'
        assert 'no-store' in response.headers['cache-control']
