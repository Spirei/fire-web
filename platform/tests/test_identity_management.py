import time
import pytest
from alcor_api.native_identity import totp_code
from alcor_api.security import digest

P='/api/auth'
PASSWORD='Synthetic9Pass'

async def test_totp_setup_confirm_backup_rotation_and_disable_are_native_and_private(client,admin,db):
    assert (await client.get('/api/account/totp')).json()['enabled'] is False
    setup=await client.post(P+'/totp/setup',json={'password':PASSWORD})
    assert setup.status_code==200,setup.text
    data=setup.json()
    assert data['qrPng'].startswith('data:image/png;base64,')
    async with db.connection() as conn:
        row=await (await conn.execute("SELECT payload FROM identity_challenges WHERE purpose='totp-setup'")).fetchone()
        assert data['secret'] not in str(row)
    bad=await client.post(P+'/totp/confirm',json={'password':PASSWORD,'challengeId':data['challengeId'],'code':'wrong-code'})
    assert bad.status_code==400
    confirmed=await client.post(P+'/totp/confirm',json={'password':PASSWORD,'challengeId':data['challengeId'],'code':totp_code(data['secret'],int(time.time())),'name':'QA factor'})
    assert confirmed.status_code==200,confirmed.text
    codes=confirmed.json()['backupCodes'];assert len(codes)==8
    status=(await client.get('/api/account/totp')).json()
    assert status=={'enabled':True,'name':'QA factor','backupCodesRemaining':8}
    rotate=await client.post(P+'/totp/backup-codes',json={'password':PASSWORD,'code':codes[0]})
    assert rotate.status_code==200,rotate.text
    new_codes=rotate.json()['backupCodes'];assert set(new_codes).isdisjoint(codes)
    assert (await client.post(P+'/totp/disable',json={'password':PASSWORD,'code':codes[1]})).status_code==403
    assert (await client.post(P+'/totp/disable',json={'password':PASSWORD,'code':new_codes[0]})).status_code==200
    assert (await client.get('/api/account/totp')).json()['enabled'] is False
    async with db.connection() as conn:
        row=await (await conn.execute('SELECT * FROM identity_security')).fetchone()
        assert row['totp_secret_ciphertext'] is None and row['backup_codes']==[]

async def test_totp_setup_requires_current_password_and_confirmation_is_session_bound(client,admin,db):
    assert (await client.post(P+'/totp/setup',json={'password':'WrongPassword9'})).status_code==403
    setup=(await client.post(P+'/totp/setup',json={'password':PASSWORD})).json()
    async with db.connection() as conn:
        await conn.execute("UPDATE identity_challenges SET binding='another-session'")
    assert (await client.post(P+'/totp/confirm',json={'password':PASSWORD,'challengeId':setup['challengeId'],'code':totp_code(setup['secret'],int(time.time()))})).status_code==400
    assert (await client.get('/api/account/totp')).json()['enabled'] is False
