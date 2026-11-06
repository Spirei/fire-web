"""Production setup policy on isolated test PG; no production target or real token."""

import asyncio

import pytest
from pydantic import SecretStr
import alcor_api.registration as registration
from test_identity_email_flows import enable, request, deliver, code, PASSWORD

TOKEN = 'synthetic-installation-proof-' + 'x' * 32


@pytest.fixture
def production_policy(settings, monkeypatch):
    # Only the policy view is production. The DB target remains identity-checked test PG.
    original = registration.require_setup_token

    async def enforce(conn, actual, provided):
        assert actual.environment == 'test'
        return await original(conn, actual.model_copy(update={'environment': 'production'}), provided)

    monkeypatch.setattr(registration, 'require_setup_token', enforce)
    return settings


@pytest.mark.parametrize('legacy', [True, False])
async def test_first_username_claim_requires_installed_proof_only_until_bootstrap(client, db, production_policy, legacy):
    path = '/api/auth/register' if legacy else '/api/session/register'
    field = 'setupToken' if legacy else 'setup_token'
    payload = {'username': 'InstallationOwner', 'password': PASSWORD}
    assert (await client.post(path, json=payload)).status_code == 503
    production_policy.registration_setup_token = SecretStr(TOKEN)
    for proof in (None, 'incorrect-installation-token', TOKEN[:-1]):
        raw = payload if proof is None else payload | {field: proof}
        refused = await client.post(path, json=raw)
        assert refused.status_code == 403, refused.text
        assert TOKEN not in refused.text and 'set-cookie' not in refused.headers
    async with db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM users')).fetchone()
        assert not await (await conn.execute('SELECT 1 FROM sessions')).fetchone()
    accepted = await client.post(path, json=payload | {field: TOKEN})
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()['user']['role'] == 'admin'
    subsequent = await client.post(path, json={'username': 'NextInstallation', 'password': PASSWORD})
    assert subsequent.status_code == 201 and subsequent.json()['user']['role'] == 'user'


@pytest.mark.parametrize('legacy', [True, False])
async def test_verified_email_cannot_bypass_first_installation_proof(client, app, db, production_policy, legacy):
    captured = enable(app, production_policy)
    stage = await request(client, 'installation@example.invalid')
    await deliver(app)
    payload = {'email': 'installation@example.invalid', 'challenge': stage['challenge'],
               'code': code(captured), 'password': PASSWORD}
    path = '/api/auth/register/email/confirm' if legacy else '/api/session/register/email/confirm'
    field = 'setupToken' if legacy else 'setup_token'
    assert (await client.post(path, json=payload)).status_code == 503
    production_policy.registration_setup_token = SecretStr(TOKEN)
    assert (await client.post(path, json=payload)).status_code == 403
    async with db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM users')).fetchone()
    accepted = await client.post(path, json=payload | {field: TOKEN})
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()['user']['role'] == 'admin'
    assert TOKEN not in accepted.text


async def test_concurrent_installed_claims_share_one_first_admin_decision(client, db, production_policy):
    production_policy.registration_setup_token = SecretStr(TOKEN)
    results = await asyncio.gather(*[
        client.post('/api/auth/register', json={'username': 'Installed' + str(i), 'password': PASSWORD, 'setupToken': TOKEN})
        for i in range(2)])
    assert [r.status_code for r in results] == [201, 201]
    assert sorted(r.json()['user']['role'] for r in results) == ['admin', 'user']
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM users WHERE role='admin'")).fetchone())['n'] == 1
