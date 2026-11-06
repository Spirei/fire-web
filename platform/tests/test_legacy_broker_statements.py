"""Legacy adapter boundaries using controlled services; no PG or broker IO."""

import hashlib
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import httpx
import pytest
from alcor_api import legacy_broker_statements as legacy
from fastapi import FastAPI, HTTPException

ACCOUNT = 'ba-'+'a'*24
PREVIEW = '12345678-1234-1234-1234-123456789abc'
REQUEST = 'abcdef12-1234-1234-1234-123456789abc'
TOKEN = 'Bearer fat_'+'a'*43


def preview_result():
    return {'state': 'previewed', 'requestId': REQUEST, 'previewId': PREVIEW, 'accountId': ACCOUNT,
            'accountKind': 'real', 'accountRevision': 1,
            'statement': {'provider': 'ibkr', 'externalAccount': 'SYNTHETIC', 'fromDate': '20260101', 'toDate': '20260131',
                          'positions': [], 'cash': [{'currency': 'USD', 'endingCash': '0'}], 'events': [], 'warnings': [],
                          'numericRepresentation': 'exact_source_decimal_text', 'sourceSha256': 'c'*64},
            'comparison': {'rows': [], 'missing': [], 'blockers': [], 'recordProof': 'd'*64,
                           'recordCollectionRevision': 2, 'requiresUnassignedAcknowledgement': False}}


class Cursor:
    def __init__(self, row=None):
        self.row = row

    async def fetchone(self):
        return self.row


class Service:
    def __init__(self):
        self.authorized = True
        self.legacy_calls = 0
        self.previews = self.confirms = self.fetches = self.configures = 0
        self.imported = None
        self.attempt = None
        self.bound = True
        self.approved = {'approved-explicit': object()}

    @asynccontextmanager
    async def context(self, who):
        if not self.authorized:
            raise HTTPException(401, '连接已变化')
        yield self

    async def execute(self, sql, args):
        if 'SELECT account_id,account_revision' in sql:
            return Cursor({'account_id': ACCOUNT, 'account_revision': 1, 'valid': True,
                           'authorization_binding': 'synthetic-binding' if self.bound else 'different-grant',
                           'parsed': preview_result()['statement']})
        if 'FROM broker_statement_import_operations' in sql:
            return Cursor({'result': self.imported, 'created_at': datetime(2026, 1, 1, tzinfo=UTC)} if self.imported else None)
        if 'SELECT statement FROM broker_statement_imports' in sql:
            return Cursor({'statement': preview_result()['statement']})
        if 'FROM broker_statement_source_attempts' in sql:
            return Cursor({'public_result': self.attempt, 'created_at': datetime(2026, 1, 1, tzinfo=UTC)} if self.attempt else None)
        return Cursor()

    async def preview(self, who, body):
        self.previews += 1
        assert body['accountId'] == ACCOUNT and body['revision'] == 1 and body['accountKind'] == 'real'
        assert body['xml'] == '<FlexQueryResponse/>'
        assert UUID(body['requestId'])
        return {**preview_result(), 'requestId': body['requestId']}

    async def binding(self, conn, who):
        return 'synthetic-binding'

    async def source(self, conn, owner, account):
        return None

    def targets(self, owner):
        return self.approved

    async def configure_source(self, who, account, body):
        self.configures += 1
        assert body['targetId'] == 'approved-explicit' and body['connectionRevision'] == 0
        assert body['accountRevision'] == 1 and body['accountKind'] == 'real'
        self.attempt = {'requestId': body['requestId'], 'state': 'configured', 'accountId': account, 'accountRevision': 2, 'connectionRevision': 1}
        return self.attempt

    async def confirm(self, who, body):
        self.confirms += 1
        assert body['confirmExternalAccount'] == 'SYNTHETIC'
        assert body['previewId'] == PREVIEW and body['takeOverOfficial'] is True
        self.imported = {'requestId': body['requestId'], 'state': 'completed', 'previewId': PREVIEW,
                         'accountId': ACCOUNT, 'sourceSha256': 'c'*64, 'accountRevision': 2,
                         'recordCollectionRevision': 3, 'created': 0, 'updated': 0, 'closed': 0}
        return self.imported

    async def legacy_fetch_source(self, who, account):
        self.legacy_calls += 1
        return {'requestId': REQUEST, 'state': 'unknown', 'accountId': account, 'legacyRequestIdGenerated': True}

    async def fetch_source(self, who, account, body):
        self.fetches += 1
        return {'requestId': body['requestId'], 'state': 'unknown', 'accountId': account}


@pytest.fixture
async def adapter(monkeypatch):
    service = Service()
    app = FastAPI()
    app.state.db = SimpleNamespace(settings=SimpleNamespace(public_origin='http://testserver'))
    app.state.broker_statements = service

    async def member(*args):
        return SimpleNamespace(id='synthetic-user'), {'client_id': legacy.CLIENT}

    async def account(conn, owner, identifier):
        if identifier != ACCOUNT:
            raise HTTPException(404, '账户不存在')
        return {'revision': 1, 'account_kind': 'real', 'holding_source': 'manual'}

    async def limits(*args, **kwargs):
        return True

    monkeypatch.setattr(legacy, 'native_identity', member)
    monkeypatch.setattr(legacy, 'broker_account', account)
    legacy.mount_legacy_broker_statements(app, limits)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        yield client, service


def test_exact_parsed_digest_is_separate_from_raw_sha_and_missing_stays_unknown():
    source = preview_result()
    output = legacy.project_preview(source, 'manual')
    assert output['previewId'] == 'bsp-'+UUID(PREVIEW).hex
    assert output['digest'] != source['statement']['sourceSha256']
    assert output['migration']['digestProtocol'] == legacy.DIGEST_PROTOCOL
    assert output['migration']['legacyParsedDigestKnown'] is False
    assert output['alreadyImported'] is None
    assert output['cash'] == [{'currency': 'USD', 'endingCash': 0.0, 'exactEndingCash': '0'}]
    source['comparison']['blockers'] = [{'reason': 'existing_quantity_unknown'}]
    with pytest.raises(legacy.AdaptationRequired):
        legacy.project_preview(source, 'manual')


@pytest.mark.parametrize('version', [1, 2])
async def test_old_apply_uses_explicit_uploaded_account_from_same_bound_preview(adapter, version):
    client, service = adapter
    prefix = f'/api/v{version}/broker-accounts/{ACCOUNT}/statements'
    result = await client.post(prefix+'/preview', headers={'authorization': TOKEN, 'x-alcor-request-id': REQUEST},
                               data={'externalAccount': 'SYNTHETIC'}, files={'file': ('statement.xml', b'<FlexQueryResponse/>')})
    assert result.status_code == 200, result.text
    assert result.json()['data']['migration']['requestId'] == REQUEST
    assert result.json()['data']['migration']['previewRequestIdGenerated'] is False
    result = await client.post(prefix+'/apply', headers={'authorization': TOKEN}, json={
        'requestId': REQUEST, 'revision': 1, 'previewId': 'bsp-'+UUID(PREVIEW).hex,
        'acknowledgeUnassigned': False, 'takeOverOfficial': True})
    assert result.status_code == 200, result.text
    assert result.json()['data']['kind'] == 'import_statement'
    assert result.json()['data']['data']['accountRevision'] == 2
    assert result.json()['data']['data']['collectionRevision'] == 3
    assert service.previews == 1 and service.confirms == 1


async def test_cookies_and_non_native_headers_never_downgrade_to_a_session(adapter):
    client, service = adapter
    client.cookies.set('alcor_session', 'synthetic-cookie')
    for headers in ({}, {'authorization': 'Bearer not-native'}, {'authorization': 'bearer fat_'+'a'*43}):
        result = await client.post(f'/api/v1/broker-accounts/{ACCOUNT}/statements/fetch', headers=headers, json={})
        assert result.status_code == 401
    assert service.fetches == 0


async def test_unknown_legacy_fetch_uses_atomic_source_admission_and_preserves_original_uuid(adapter):
    client, service = adapter
    path = f'/api/v2/broker-accounts/{ACCOUNT}/statements/fetch'
    result = await client.post(path, headers={'authorization': TOKEN})
    assert result.status_code == 503 and service.fetches == 0 and service.legacy_calls == 1
    assert result.json()['data']['canonicalReceipt']['requestId'] == REQUEST
    result = await client.post(path, headers={'authorization': TOKEN})
    assert result.status_code == 503 and service.fetches == 0 and service.legacy_calls == 2
    assert result.json()['data']['canonicalReceipt']['requestId'] == REQUEST
    result = await client.post(path, headers={'authorization': TOKEN}, json={'requestId': REQUEST, 'connectionRevision': 1})
    assert result.status_code == 503 and service.fetches == 1
    assert result.json()['data']['canonicalReceipt']['requestId'] == REQUEST
    assert result.json()['data']['receiptPath'].endswith(REQUEST)


async def test_revoked_grant_after_async_multipart_input_cannot_make_preview(adapter, monkeypatch):
    client, service = adapter
    original = legacy.bounded_body

    async def revoke(request, limit):
        raw = await original(request, limit)
        service.authorized = False
        return raw

    monkeypatch.setattr(legacy, 'bounded_body', revoke)
    result = await client.post(f'/api/v1/broker-accounts/{ACCOUNT}/statements/preview', headers={'authorization': TOKEN},
                               data={'externalAccount': 'SYNTHETIC'}, files={'file': ('statement.xml', b'<FlexQueryResponse/>')})
    assert result.status_code == 401 and service.previews == 0
    assert result.headers['x-alcor-retire-context'] == 'true'


async def test_legacy_connection_binds_only_unique_explicit_owner_permission(adapter):
    client, service = adapter
    path = f'/api/v1/broker-accounts/{ACCOUNT}/connection'
    body = {'requestId': REQUEST, 'revision': 1, 'externalAccount': 'SYNTHETIC', 'token': 'PRIVATEFLEXTOKEN', 'queryId': '42'}
    response = await client.put(path, headers={'authorization': TOKEN}, json=body)
    assert response.status_code == 200, response.text
    assert response.json()['data']['data'] == {'configured': True}
    assert service.configures == 1 and 'PRIVATEFLEXTOKEN' not in response.text
    for approved, expected in (({}, 503), ({'one': object(), 'two': object()}, 409)):
        service.approved = approved
        response = await client.put(path, headers={'authorization': TOKEN}, json=body)
        assert response.status_code == expected
        assert service.configures == 1


async def test_other_grant_bound_preview_cannot_be_applied_with_legacy_fields(adapter):
    client, service = adapter
    service.bound = False
    result = await client.post(f'/api/v2/broker-accounts/{ACCOUNT}/statements/apply', headers={'authorization': TOKEN}, json={
        'requestId': REQUEST, 'revision': 1, 'previewId': 'bsp-'+UUID(PREVIEW).hex,
        'acknowledgeUnassigned': False, 'takeOverOfficial': True})
    assert result.status_code == 409 and service.confirms == 0


def test_exact_digest_does_not_round_adjacent_decimal_observations():
    first, second = preview_result()['statement'], preview_result()['statement']
    first['cash'][0]['endingCash'] = '1.000000000000000001'
    second['cash'][0]['endingCash'] = '1.000000000000000002'
    assert legacy.exact_digest(first) != legacy.exact_digest(second)


def test_frozen_ts_and_swift_sources_retain_original_preview_reference_confirmation():
    root = Path(__file__).parent / 'fixtures/broker-statement-client-source'
    for name, expected in json.loads((root/'source-sha256.json').read_text()).items():
        assert hashlib.sha256((root/name).read_bytes()).hexdigest() == expected
    original = (root/'AlcorBrokerStatementsAPI.swift').read_text()
    assert '"previewId": id' in original and '"acknowledgeUnassigned": separate' in original
    assert 'confirmExternalAccount' not in original
    assert '"^bsp-[a-f0-9]{32}$"' in (root/'AlcorBrokerStatement.swift').read_text()


def test_legacy_cash_display_distinguishes_exponent_zero_from_nonzero_underflow():
    for text in ('0e5', '0E-8', '-0.000', '0'):
        assert legacy.display_cash([{'currency': 'USD', 'endingCash': text}])[0]['endingCash'] == 0
    with pytest.raises(legacy.AdaptationRequired):
        legacy.display_cash([{'currency': 'USD', 'endingCash': '1e-999'}])
