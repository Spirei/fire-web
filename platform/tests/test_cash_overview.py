"""Owner cash books retain unknowns and never absorb provider report balances."""

from uuid import uuid4

from source_pure_read_candidate.test_reads import snapshot as business_snapshot
from test_broker_statement_integration import BASE, XML
from test_cash_ledger import account, command, submit


async def test_owner_cash_read_is_pure_and_kind_and_official_sources_remain_separate(client, db, admin):
    before = await business_snapshot(db)
    response = await client.get('/api/account/cash-overview')
    assert response.status_code == 200, response.text
    assert all(book['currencies'] == [] for book in response.json()['books'])
    assert await business_snapshot(db) == before
    real = await account(client, 'Synthetic actual cash', 'real')
    simulated = await account(client, 'Synthetic paper cash', 'simulated')

    async def read():
        response = await client.get('/api/account/cash-overview')
        assert response.status_code == 200, response.text
        return response.json()

    initial = await read()
    assert all(row['ownerBalance'] is None for book in initial['books'] for row in book['currencies'])
    await submit(client, command(real, amount='0'))
    await submit(client, command(simulated, amount='1000', accountKind='simulated'))
    funded = await read()
    books = {book['accountKind']: {row['currency']: row for row in book['currencies']} for book in funded['books']}
    assert books['real']['USD']['ownerBalance'] == '0'
    assert books['simulated']['USD']['ownerBalance'] == '1000'
    assert books['real']['HKD']['ownerBalance'] is None
    preview = await client.post(BASE + '/preview', json={
        'requestId': str(uuid4()), 'accountId': real, 'accountKind': 'real', 'revision': 1,
        'externalAccount': 'SYNTHETIC', 'xml': XML,
    })
    assert preview.status_code == 200, preview.text
    imported = await client.post(BASE + '/imports', json={
        'requestId': str(uuid4()), 'previewId': preview.json()['previewId'],
        'confirmExternalAccount': 'SYNTHETIC', 'takeOverOfficial': True, 'acknowledgeUnassigned': True,
    })
    assert imported.status_code == 200, imported.text
    after = await read()
    books = {book['accountKind']: {row['currency']: row for row in book['currencies']} for book in after['books']}
    assert books['real']['USD']['ownerBalance'] == '0'
    assert books['real']['EUR']['ownerBalance'] is None
    assert books['simulated']['USD']['ownerBalance'] == '1000'
    observed = next(row for row in after['accounts'] if row['accountId'] == real)
    amounts = {row['currency']: row['balance'] for row in observed['snapshot']['currencies']}
    assert amounts['EUR'] == '25' and amounts['USD'] == '0'
    assert not observed['ledgerWithdrawalCapacities']['USD']['complete']
    assert after['snapshotRevision'] != funded['snapshotRevision']
    before = await business_snapshot(db)
    assert await read() == after
    assert await business_snapshot(db) == before


async def test_shared_scope_keeps_registered_postings_separate_from_actual_cash(client, admin, monkeypatch):
    first = await account(client, 'First allocated account')
    second = await account(client, 'Second allocated account')
    await submit(client, command(None, amount='1000'))
    for identifier, amount in ((first, '200'), (second, '300')):
        await submit(client, command(identifier, amount=amount, openingBasis='allocate_verified_unallocated_checkpoint'))

    async def read():
        response = await client.get('/api/account/cash-overview')
        assert response.status_code == 200, response.text
        return response.json()

    def usd_book(data):
        real = next(book for book in data['books'] if book['accountKind'] == 'real')
        return next(row for row in real['currencies'] if row['currency'] == 'USD')

    known = usd_book(await read())
    assert known['ownerBalance'] == '1000'
    assert known['registeredAttributedBalance'] == '500'
    assert known['unallocatedBalance'] == '500'

    from alcor_api import actual_projection
    original = actual_projection.actual_cash_known

    async def unresolved_owner_fees(conn, owner, kind, currency, account=None):
        if (kind, currency, account) == ('real', 'USD', None):
            return False
        return await original(conn, owner, kind, currency, account)

    monkeypatch.setattr(actual_projection, 'actual_cash_known', unresolved_owner_fees)
    unresolved = await read()
    usd = usd_book(unresolved)
    assert usd['registeredOwnerBalance'] == '1000'
    assert usd['registeredAttributedBalance'] == '500'
    assert usd['registeredUnallocatedBalance'] == '500'
    assert usd['complete'] is False
    assert usd['ownerBalance'] is usd['unallocatedBalance'] is usd['availableOwnerBalance'] is None
    assert all(not row['ledgerWithdrawalCapacities']['USD']['complete'] for row in unresolved['accounts'])
