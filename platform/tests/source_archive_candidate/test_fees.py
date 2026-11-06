from uuid import uuid4

import pytest
from actual_fee_test_support import actual_case
from legacy_fee_source_fixture import old_pg
from source_archive_candidate.test_archive import expire, revoke
from test_registered_fee_baselines import pure_command

__all__ = ['old_pg']


@pytest.mark.parametrize('withdraw', [False, True])
async def test_archived_53_baseline_and_49_actual_confirmation_after_source_retirement_still_require_current_consent(client, admin, app, old_pg, pg, tmp_path, withdraw):
    async with actual_case(client, admin, app, old_pg, pg, tmp_path) as (approved, hosted, grant, exported, account, fill, actual):
        expire(hosted.state.settings)
        hosted.state.settings.legacy_source_registry_path.unlink()
        hosted.state.source_authority.registry = {}
        selected = actual['confirmations'][0]['originalOrderId']
        baseline = pure_command(admin, exported, account, selected, fill)
        proof = await approved.post('/api/fees/baselines/preview', json=baseline)
        assert proof.status_code == 200 and proof.json()['ready'], proof.text
        done = await approved.post('/api/fees/baselines/operations', json={'data': baseline, 'preview': proof.json()['preview']})
        assert done.status_code == 200 and done.json()['state'] == 'completed' and not done.json()['financialApplied'], done.text
        state = (await approved.get('/api/fees/confirmations', params={'brokerAccountId': account})).json()
        actual.update(brokerRevision=state['brokerRevision'], snapshotRevision=state['snapshotRevision'])
        proof = await approved.post('/api/fees/confirmations/preview', json=actual)
        assert proof.status_code == 200 and proof.json()['previewRevision'], proof.text
        if withdraw:
            await revoke(approved, grant)
        result = await approved.post('/api/fees/confirmations/operations', json={'data': actual, 'preview': proof.json()['previewRevision']})
        if withdraw:
            assert result.status_code == 200 and result.json()['state'] == 'failed' and result.json()['status'] == 409 and '撤销' in result.text, result.text
            assert (await approved.get('/api/fees/confirmations/operations/'+actual['requestId'])).json() == result.json()
            denied = await approved.post('/api/fees/baselines/preview', json={**baseline, 'requestId': str(uuid4()), 'expectedRevision': 1})
            assert denied.status_code == 409
            async with hosted.state.db.connection() as conn:
                assert (await (await conn.execute('SELECT count(*) n FROM actual_fee_confirmations')).fetchone())['n'] == 0
        else:
            assert result.status_code == 200 and result.json()['state'] == 'completed' and result.json()['actualFeeKnown'], result.text
            assert (await approved.get('/api/fees/confirmations/operations/'+actual['requestId'])).json() == result.json()
        blocked = await approved.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots', json={'requestId': str(uuid4()), 'grantRevision': grant['grantRevision'], 'predecessorHash': exported['manifestSha256']})
        assert blocked.status_code == 409
