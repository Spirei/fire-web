# ruff: noqa: F811 -- imported existing pytest fixtures are injected by name
"""Encrypted real capsule restores private originals without restoring external authority."""
from uuid import UUID, uuid4

import httpx
from alcor_api.main import create_app
from test_backups import backup_app, bc, configured  # noqa: F401 -- existing isolated restore fixtures
from test_backups import (
    test_manual_card_wallet_backup_restores_exact_history_and_owner_secrets_without_broker_merging as wallet_backup,
)
from f27_card_candidate.test_recognition import ROOT, image, install, upload


async def test_card_recognition_originals_and_wallet_financial_receipts_survive_quarantined_restore(bc,backup_app,configured,monkeypatch):
    import json

    from alcor_api.security import COOKIE, digest
    async with backup_app.state.db.connection() as conn:
        uid=(await(await conn.execute('SELECT user_id FROM sessions WHERE token_hash=%s',(digest(bc.cookies[COOKIE]),))).fetchone())['user_id']
    install(configured,uid)
    raw=json.dumps({'model':'deepseek-flash','choices':[{'finish_reason':'stop','message':{'content':'{"name":"Synthetic"}'}}]}).encode()
    calls=[]
    async def fetch(target,prepared,mime,*,before_request=None):
        await before_request()
        calls.append(1)
        return raw,200,True
    monkeypatch.setattr(backup_app.state.card_recognition,'fetch',fetch)
    rid=str(uuid4())
    recognized=await upload(bc,rid)
    assert recognized.status_code==200 and recognized.json()['state']=='recognized',recognized.text
    # Existing complete wallet/key/cash-isolation assertions execute in this same capsule.
    await wallet_backup(bc,backup_app,configured)
    target=configured.restore_targets[0]
    restored=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'connection_secret_dir':target.recovery_directory/'connection-secrets','file_root':target.recovery_directory/'files','restore_targets':[]})
    app=create_app(restored)
    async with app.router.lifespan_context(app),httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as recovered:
        login=await recovered.post('/api/session/login',json={'login':'BackupQA','password':'Synthetic9Pass'})
        assert login.status_code==200,login.text
        recovered.headers['x-csrf-token']=login.json()['csrf']
        receipt=await recovered.get(ROOT+'/operations/'+rid)
        assert receipt.status_code==200 and receipt.json()['state']=='unavailable' and receipt.json()['card'] is None,receipt.text
        assert (await recovered.get(ROOT+'/operations/'+rid+'/input')).content==image()
        assert (await recovered.get(ROOT+'/originals/'+recognized.json()['sourcePageId'])).content==raw
        assert len(calls)==1
        async with app.state.db.connection() as conn:
            row=await(await conn.execute('SELECT result,origin_instance FROM card_recognition_operations WHERE owner_id=%s AND request_id=%s',(uid,UUID(rid)))).fetchone()
            assert row['result']['state']=='recognized' and row['origin_instance']==configured.instance_id
