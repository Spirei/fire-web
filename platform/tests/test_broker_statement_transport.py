"""Transport checks without PostgreSQL, external fetch, or financial mutation."""
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from alcor_api import broker_metadata_api, broker_statements_api
from alcor_api.main import BodyBudget
from alcor_api.profile_http import body_budget
from fastapi import FastAPI, HTTPException


@pytest.mark.parametrize('module,namespace', [
    (broker_statements_api, 'broker-statements'),
    (broker_metadata_api, 'broker-metadata'),
])
async def test_owner_switch_rejection_keeps_session_retirement_header(monkeypatch, module, namespace):
    app = FastAPI()
    app.state.db = SimpleNamespace()

    async def changed(_):
        raise HTTPException(403, '登录身份已变化', headers={'X-Alcor-Session-Changed': 'true'})

    async def budget(*args, **kwargs):
        raise AssertionError('rejected identity must not consume mutation budget')

    monkeypatch.setattr(module, 'identity', changed)
    if module is broker_statements_api:
        module.mount_broker_statements(app, budget)
        path = f'/api/account/{namespace}/operations/{uuid4()}'
    else:
        module.mount_broker_metadata(app, budget)
        path = f'/api/account/{namespace}'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        result = await client.get(path)
    assert result.status_code == 403
    assert result.headers['x-alcor-session-changed'] == 'true'
    assert result.headers['x-alcor-retire-context'] == 'true'
    assert result.headers['cache-control'] == 'no-store, private'


async def test_original_is_an_attachment_and_never_an_inline_xml_document(monkeypatch):
    app = FastAPI()
    app.state.db = SimpleNamespace()

    async def member(_):
        return SimpleNamespace(id='synthetic-owner')

    async def original(who, source):
        assert who.id == 'synthetic-owner'
        return b'<synthetic-original/>', 'a' * 64

    monkeypatch.setattr(broker_statements_api, 'identity', member)
    broker_statements_api.mount_broker_statements(app, None)
    monkeypatch.setattr(app.state.broker_statements, 'original', original)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        result = await client.get(f'/api/account/broker-statements/originals/{uuid4()}')
    assert result.content == b'<synthetic-original/>'
    assert result.headers['content-type'] == 'application/octet-stream'
    assert result.headers['content-disposition'] == 'attachment; filename="statement.xml"'
    assert result.headers['x-content-type-options'] == 'nosniff'
    assert result.headers['cache-control'] == 'no-store, private'


def test_only_exact_statement_upload_paths_accept_json_escaped_originals():
    for client in ('account', 'client'):
        path = f'/api/{client}/broker-statements/preview'
        assert body_budget(path) == 6 * 8 * 1024 * 1024 + 4096
        for other in (path + '/extra', path + '/', path.replace('/preview', '/operations')):
            assert body_budget(other) == 65536


async def test_statement_transport_passes_large_source_through_global_budget(monkeypatch):
    app = FastAPI()
    app.state.db = SimpleNamespace()
    app.add_middleware(BodyBudget)

    async def member(_):
        return SimpleNamespace(id='synthetic-owner')

    async def budget(*args, **kwargs):
        return True

    source = 'x' * 70000

    async def preview(who, raw):
        assert who.id == 'synthetic-owner' and raw == {'xml': source}
        return {'financialEffect': 'none'}

    monkeypatch.setattr(broker_statements_api, 'identity', member)
    broker_statements_api.mount_broker_statements(app, budget)
    monkeypatch.setattr(app.state.broker_statements, 'preview', preview)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        result = await client.post('/api/account/broker-statements/preview', json={'xml': source})
    assert result.status_code == 200
