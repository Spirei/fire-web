"""Pure legacy HTML goldens and administrator preview without delivery or writes."""

import hashlib
import json
import subprocess
from pathlib import Path

import pytest
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES
from alcor_api.backups import tables_and_hashes
from alcor_api.cli import create_user
from alcor_api.mail_template_model import DEFAULTS
from alcor_api.mail_template_renderer import render_mail

PATH = '/api/settings/mail-templates/preview'
FIXTURES = Path(__file__).parent / 'mail_templates_candidate'


def test_full_legacy_html_and_text_goldens():
    cases = json.loads((FIXTURES / 'preview-golden.json').read_text())
    assert len(cases) == 12
    for case in cases:
        assert render_mail(case['template'], case['values'], '/api/system-assets/mail-banner') == case['rendered']
        assert '<script>' not in case['rendered']['html']


def test_goldens_reproduce_reviewed_original_typescript():
    source = Path(__file__).parent / 'fixtures/mail-preview-source'
    manifest = json.loads((source / 'source.json').read_text())
    for name, digest in manifest['files'].items():
        assert hashlib.sha256((source / name).read_bytes()).hexdigest() == digest
    fixture = FIXTURES / 'preview-golden.json'
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == manifest['golden_sha256']
    result = subprocess.run(['node', '--experimental-vm-modules', str(FIXTURES / 'preview_source.cjs'), str(source)], capture_output=True, text=True, check=True, timeout=15)
    assert json.loads(result.stdout) == json.loads(fixture.read_text())


async def test_js_trim_and_isolated_surrogate_json_response(client, settings):
    await legacy_admin(client, settings)
    template = {**DEFAULTS[0], 'title': '\ufeffSafe\ufeff', 'body': '\ud800'}
    response = await client.post(PATH, content=json.dumps(template), headers={'content-type': 'application/json'})
    assert response.status_code == 200
    assert '<h1' in response.json()['html'] and '>Safe</h1>' in response.json()['html']
    assert '\ud800' in response.json()['html']
    template['title'] = '\u0085Safe\u0085'
    response = await client.post(PATH, content=json.dumps(template))
    assert response.status_code == 200 and '\u0085Safe\u0085' in response.json()['html']


async def legacy_admin(client, settings):
    user = await create_user(settings, 'PreviewAdmin', 'SyntheticPreview9Pass', role='admin')
    response = await client.post('/api/auth/login', json={'username': 'PreviewAdmin', 'password': 'SyntheticPreview9Pass'})
    assert response.status_code == 200
    return user


async def hashes(db):
    async with db.connection() as conn, conn.transaction():
        observed = await tables_and_hashes(conn)
        # HTTP observation may drain asynchronously; business/audit tables remain checked.
        telemetry = REQUEST_TELEMETRY_TABLES
        return {name:value for name,value in observed.items() if name not in telemetry}


async def test_all_previews_match_original_source_and_never_write(client, settings, db):
    await legacy_admin(client, settings)
    before = await hashes(db)
    for case in json.loads((FIXTURES / 'preview-golden.json').read_text()):
        response = await client.post(PATH, json=case['template'])
        assert response.status_code == 200, response.text
        assert response.json() == case['rendered']
        assert response.headers['cache-control'] == 'private, no-store'
    assert await hashes(db) == before


async def test_preview_permissions_origin_and_legacy_bearer(client, settings, db):
    assert (await client.post(PATH, json=DEFAULTS[0])).json() == {'error': '需要管理员权限'}
    await legacy_admin(client, settings)
    token = client.cookies['fire_session']
    assert (await client.post(PATH, json=DEFAULTS[0], headers={'origin': 'https://other.invalid'})).status_code == 403
    assert (await client.post(PATH, json=DEFAULTS[0], headers={'authorization': 'Bearer fat_' + 'a' * 43})).status_code == 403
    assert (await client.post(PATH, json=DEFAULTS[0], headers={'authorization': 'Bearer ' + token})).status_code == 200
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE username='PreviewAdmin'")
    assert (await client.post(PATH, json=DEFAULTS[0])).status_code == 403


@pytest.mark.parametrize('payload', [None, [], {}, {'id': 'invalid'}])
async def test_invalid_preview_has_original_error_and_no_writes(client, settings, db, payload):
    await legacy_admin(client, settings)
    before = await hashes(db)
    response = await client.post(PATH, content=json.dumps(payload), headers={'content-type': 'application/json'})
    assert response.status_code == 400 and response.json() == {'error': '模板格式无效'}
    oversized = await client.post(PATH, content=b'{' + b' ' * 17000 + b'}')
    assert oversized.status_code == 400 and oversized.json() == {'error': '模板格式无效'}
    assert await hashes(db) == before


async def test_demoted_while_body_arrives_is_denied(client, settings, db, monkeypatch):
    from alcor_api import legacy_mail_preview

    user = await legacy_admin(client, settings)
    original = legacy_mail_preview.bounded_body

    async def demote(request, limit):
        raw = await original(request, limit)
        async with db.connection() as conn:
            await conn.execute("UPDATE users SET role='user' WHERE id=%s", (user,))
        return raw

    monkeypatch.setattr(legacy_mail_preview, 'bounded_body', demote)
    response = await client.post(PATH, json=DEFAULTS[0])
    assert response.status_code == 403 and response.json() == {'error': '登录已失效'}
    async with db.connection() as conn:
        for table in ('identity_mail_outbox', 'mail_template_operations', 'mail_template_state'):
            assert not await (await conn.execute('SELECT 1 FROM ' + table)).fetchone()


async def test_canonical_editor_preview_uses_same_renderer_and_csrf(client, admin, db):
    before = await hashes(db)
    cases = json.loads((FIXTURES / 'preview-golden.json').read_text())
    for case in cases:
        response = await client.post('/api/system/mail-templates/preview', json=case['template'])
        assert response.status_code == 200 and response.json() == case['rendered']
    denied = await client.post('/api/system/mail-templates/preview', json=DEFAULTS[0], headers={'x-csrf-token': ''})
    assert denied.status_code == 403
    denied = await client.post('/api/system/mail-templates/preview', json=DEFAULTS[0], headers={'authorization': 'Bearer invalid'})
    assert denied.status_code == 403
    assert await hashes(db) == before
