"""Deferred native source writes retain original receipts and append compensation."""

from uuid import UUID, uuid4

from test_cash_ledger import command, submit
from test_legacy_devices import bearer, grant


async def test_native_funds_replay_search_and_retirement_preserve_originals(client, admin, db):
    await submit(client, command(None, amount='100'))
    headers = bearer(await grant(db, admin, 'portfolio.read portfolio.write cash.read'))
    original_id = str(uuid4())
    body = {'currency': 'USD', 'type': 'deposit', 'amount': 25, 'direction': 1, 'note': '本人转入',
            'occurredAt': '2026-01-02T00:00:00Z'}
    deposited = await client.post('/api/v1/funds', json=body,
                                  headers={**headers, 'x-alcor-request-id': original_id})
    assert deposited.status_code == 200, deposited.text
    receipt = deposited.json()['data']
    source = receipt['transaction']['id']
    assert receipt['requestId'] == original_id and receipt['legacyClientIdempotency'] is True
    assert receipt['transaction']['amount'] == 25
    changed = await client.post('/api/v2/funds', json={**body, 'type': 'withdrawal', 'amount': 10, 'direction': -1},
                               headers={**headers, 'x-alcor-request-id': str(uuid4())})
    assert changed.status_code == 200, changed.text
    repeated = await client.post('/api/v2/funds', json=body,
                                headers={**headers, 'x-alcor-request-id': original_id})
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()['data'] == receipt
    found = await client.get('/api/v2/funds?q=zhuanru&recordsOnly=1', headers=headers)
    assert found.status_code == 200, found.text
    assert any(row['id'] == source for row in found.json()['data']['transactions'])
    retired = await client.delete('/api/v1/funds/' + source,
                                  headers={**headers, 'x-alcor-request-id': str(uuid4())})
    assert retired.status_code == 200, retired.text
    async with db.connection() as conn:
        original = await (await conn.execute(
            'SELECT f.cash_entry_id,e.amount,r.reversal_entry_id FROM fund_sources f '
            'JOIN cash_ledger_entries e ON e.id=f.cash_entry_id '
            'JOIN fund_source_retirements r ON r.owner_id=f.owner_id AND r.source_id=f.id '
            'WHERE f.owner_id=%s AND f.id=%s', (admin, source),
        )).fetchone()
        assert original['amount'] == 25 and original['reversal_entry_id'] != original['cash_entry_id']
        amount = (await (await conn.execute(
            "SELECT sum(amount) AS amount FROM cash_ledger_entries WHERE owner_id=%s AND account_kind='real' AND currency='USD' AND affects_owner",
            (admin,),
        )).fetchone())['amount']
        assert amount == 90


async def test_old_web_funds_without_new_headers_keep_original_receipt_and_cannot_downgrade_native_auth(client, admin, db):
    await submit(client, command(None, amount='100'))
    login = await client.post('/api/auth/login', json={'username': 'AdminOne', 'password': 'Synthetic9Pass'})
    assert login.status_code == 200, login.text
    body = {'currency': 'USD', 'type': 'deposit', 'amount': 25, 'direction': 1,
            'note': 'Synthetic old Web deposit', 'occurredAt': '2026-01-02T00:00:00Z'}
    created = await client.post('/api/v1/funds', json=body)
    assert created.status_code == 200, created.text
    receipt = created.json()['data']
    assert receipt['legacyClientIdempotency'] is False
    original = str(UUID(receipt['requestId']))
    source_id = receipt['transaction']['id']
    # The generated identifier belongs to the real admission and can be replayed
    # explicitly. An old client is never described as having supplied it.
    replay = await client.post('/api/v1/funds', json=body, headers={'x-alcor-request-id': original})
    assert replay.status_code == 200, replay.text
    assert replay.json()['data']['requestId'] == original
    assert replay.json()['data']['transaction'] == receipt['transaction']
    for path, headers in [('/api/v2/funds', {}), ('/api/v1/funds', {'authorization': 'Bearer invalid'})]:
        denied = await client.post(path, json=body, headers=headers)
        assert denied.status_code == 401, denied.text
    read = await client.get('/api/v1/funds?recordsOnly=1')
    assert read.status_code == 200 and any(row['id'] == source_id for row in read.json()['data']['transactions'])
    retired = await client.delete('/api/v1/funds/' + source_id)
    assert retired.status_code == 200, retired.text
    async with db.connection() as conn:
        row = await (await conn.execute('SELECT e.amount,r.reversal_entry_id FROM fund_sources f JOIN cash_ledger_entries e ON e.id=f.cash_entry_id JOIN fund_source_retirements r ON r.owner_id=f.owner_id AND r.source_id=f.id WHERE f.owner_id=%s AND f.id=%s', (admin,source_id))).fetchone()
        assert row['amount'] == 25 and row['reversal_entry_id']
        assert (await (await conn.execute("SELECT sum(amount) balance FROM cash_ledger_entries WHERE owner_id=%s AND account_kind='real' AND currency='USD' AND affects_owner", (admin,))).fetchone())['balance'] == 100
