"""Ambiguous credentials cannot select a valid first token or borrow cookies."""
import pytest
from test_legacy_trade_corrections import native_headers


@pytest.mark.parametrize('version', [1, 2])
async def test_native_all_order_authorities_reject_duplicate_or_empty_authorization(client, admin, db, version):
    valid = (await native_headers(db, admin))['authorization']
    entries = [('GET','account-assets'), ('GET','account-assets/orders'), ('GET','account-assets/trading'),
               ('POST','account-assets/trading/preview'), ('POST','account-assets/trading/corrections/preview'),
               ('POST','account-assets/orders/cancellations')]
    async with db.connection() as conn:
        before = (await (await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']
    for method, suffix in entries:
        for headers in ({'authorization':''}, {'authorization':'Bearer '}, [('authorization',valid),('authorization','Bearer invalid')]):
            response = await client.request(method,f'/api/v{version}/'+suffix,headers=headers,**({'json':{}} if method=='POST' else {}))
            assert response.status_code == 401, (suffix,response.text)
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n'] == before
