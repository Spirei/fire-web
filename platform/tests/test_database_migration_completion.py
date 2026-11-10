"""Real one-command cutover with backup, original files, rollback and old TOTP login."""
import base64
import asyncio
import hashlib
import json
import os
import time
import threading
from io import BytesIO
from datetime import UTC,datetime
from uuid import uuid4

import cbor2
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import psycopg
import pytest
from PIL import Image

from alcor_api.backups import BackupFailure
from alcor_api.connections import Vault
from alcor_api.database_migration_capture import sha,canonical
from alcor_api.database_migration_jobs import execute as prepare
from alcor_api.database_migration_conversion import execute as convert
from alcor_api.database_migration_portfolio import execute as portfolio
from alcor_api.database_migration_completion import execute as complete
from alcor_api.native_identity import totp_code
from alcor_api.passwords import hash_password,verify_password
from alcor_api.worker import claim,finish
from test_database_migration_preparation import migration_source
from test_database_migration_conversion import add_source


async def test_full_cutover_keeps_completed_domains_and_restores_original_credentials(client,db,settings,pg,migration_source,tmp_path,monkeypatch):
    cfg,revision=migration_source;dsn=pg.get_uri(database=cfg['database']);add_source(dsn)
    Vault(settings.connection_secret_dir).key()
    key=os.urandom(32);secret='JBSWY3DPEHPK3PXP';iv=os.urandom(12);encrypted=AESGCM(hashlib.sha256(key).digest()).encrypt(iv,secret.encode(),None)
    packed='enc:v1:'+':'.join(base64.b64encode(v).decode() for v in (iv,encrypted[-16:],encrypted[:-16]))
    old_hash=hash_password('Retained9Pass');card=uuid4();passkey_id='c3ludGhldGljLW1pZ3JhdGlvbg'
    public=ec.generate_private_key(ec.SECP256R1()).public_key().public_numbers()
    cose=cbor2.dumps({1:2,3:-7,-1:1,-2:public.x.to_bytes(32,'big'),-3:public.y.to_bytes(32,'big')})
    picture=BytesIO();Image.new('RGB',(8,4),'blue').save(picture,format='JPEG');background=picture.getvalue()
    with psycopg.connect(dsn) as c:
        c.execute("ALTER TABLE ledger.users ADD COLUMN uid text DEFAULT '1',ADD COLUMN role text DEFAULT 'admin',ADD COLUMN created_at text DEFAULT '2020-01-01T00:00:00Z',ADD COLUMN totp_enabled integer DEFAULT 1,ADD COLUMN totp_secret text,ADD COLUMN totp_last_step bigint DEFAULT -1,ADD COLUMN totp_backup_codes text DEFAULT '[]'")
        c.execute("UPDATE ledger.users SET username='RetainedOwner',password_hash=%s,totp_secret=%s",(old_hash,packed))
        c.execute('CREATE TABLE ledger.passkey_config(value text)');c.execute('INSERT INTO ledger.passkey_config VALUES(%s)',(json.dumps({'enabled':True,'origin':'http://testserver','rpID':'testserver','name':'Original','revision':'source-config'}),))
        c.execute('CREATE TABLE ledger.passkeys(id text,user_id text,user_handle text,rp_id text,public_key bytea,counter bigint,transports text,name text,backed_up boolean,created_at bigint,last_used_at bigint)')
        c.execute("INSERT INTO ledger.passkeys VALUES(%s,'source-owner','c291cmNlLW93bmVy','testserver',%s,7,'[\"internal\"]','Source key',true,1700000000123,NULL)",(passkey_id,cose))
        c.execute('CREATE TABLE ledger.assets(id text,type text,market text,code text,name text,url text,url_dark text)')
        c.execute('CREATE TABLE ledger.personal_profiles(user_id text,bio text,gender text,background bytea,initialized text)')
        c.execute("INSERT INTO ledger.personal_profiles VALUES('source-owner','Original bio','unspecified',%s,'[\"bio\",\"background\"]')",(background,))
        c.execute("INSERT INTO ledger.assets VALUES('stock:US:TEST','stock','US','TEST','Original security','/uploads/asset/stock/US/TEST.svg','')")
        for number in range(1,10):
            c.execute("INSERT INTO ledger.assets VALUES(%s,'stock','US',%s,'Original security','/uploads/asset/stock/US/TEST.svg','')",('stock:US:TEST'+str(number),'TEST'+str(number)))
        c.execute('CREATE TABLE ledger.user_settings(user_id text,fire text,simple text)')
        from alcor_api.simple_ledger import defaults
        simple=defaults();simple['cash']=[{'id':'source-cash','name':'Original cash','amount':123.125,'currency':'CNY','member':'me'}]
        c.execute("INSERT INTO ledger.user_settings VALUES('source-owner',%s,%s)",(json.dumps({'baseCurrency':'USD','annualExpense':123,'assetHistory':[],'tableRows':[]}),json.dumps(simple)))
        c.execute('CREATE TABLE ledger.custom_cards(id text,user_id text,name text,bank text,region text,type text,brand text,level text,image text,currency_scope text,created_at timestamptz)')
        c.execute("INSERT INTO ledger.custom_cards VALUES(%s,'source-owner','Original card','Original bank','CN','借记卡','Visa','','/uploads/asset/card/TEST.svg','',now())",(str(card),))
        c.execute('CREATE TABLE ledger.card_holdings(user_id text,card_key text,created_at timestamptz)');c.execute("INSERT INTO ledger.card_holdings VALUES('source-owner','/uploads/asset/card/TEST.svg',now())")
    settings.public_upload_root=tmp_path/'uploads';settings.public_upload_root.mkdir(mode=0o700)
    settings.file_root=tmp_path/'files';settings.asset_root=tmp_path/'assets'
    raw=b'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#0866ff"/></svg>'
    files=[]
    for path in ('asset/stock/US/TEST.svg','asset/card/TEST.svg'):
        file=settings.public_upload_root/path;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(raw)
        files.append({'path':'uploads/'+path,'bytes':len(raw),'sha256':sha(raw)})
    p=await client.post('/api/fire/database-migration/preparations',json={'request_id':str(uuid4()),'source_revision':revision});assert p.status_code==202,p.text
    t=await claim(db,uuid4());await prepare(db,t)
    c=await client.post('/api/fire/database-migration/preparations/'+str(t['id'])+'/conversion',json={'request_id':str(uuid4()),'source_owner':'source-owner','timezone':'Asia/Shanghai','account_kinds':{'old-account':'real'},'market_accounts':{'US':'old-account'}});assert c.status_code==202,c.text
    cv=await claim(db,uuid4());await convert(db,cv)
    value=(await client.get('/api/fire/tasks/'+str(cv['id']))).json()['result']
    endpoint='/api/fire/database-migration/conversions/'+str(cv['id']);body={'request_id':str(uuid4()),'plan_sha256':value['plan_sha256'],'confirmed_registered_values':True}
    accepted=await client.post(endpoint+'/portfolio',json=body);assert accepted.status_code==202,accepted.text
    job=await claim(db,uuid4());await portfolio(db,job)
    plan=json.loads((settings.backup_dir/'database-migration-conversions'/str(cv['id'])/'attempt-1/conversion-plan.json').read_bytes())
    inputs=settings.backup_dir/'migration-completion-input';inputs.mkdir(mode=0o700)
    (inputs/'source-data.key').write_bytes(key);(inputs/'source-data.key').chmod(0o600)
    (inputs/'media-manifest.json').write_bytes(canonical({'source_instance':plan['portfolio']['source_instance'],'source_owner':'source-owner','files':files}));(inputs/'media-manifest.json').chmod(0o600)
    command=body|{'request_id':str(uuid4())};admitted=await client.post(endpoint+'/complete',json=command);assert admitted.status_code==202,admitted.text
    full=await claim(db,uuid4())
    # Reopening/another tab attaches to the running job, even with a fresh
    # request UUID, and task reads do not acquire the worker's row lock.
    duplicate=await client.post(endpoint+'/complete',json=command|{'request_id':str(uuid4())})
    assert duplicate.status_code==202 and duplicate.json()['id']==str(full['id'])
    async with db.connection() as locked,locked.transaction():
        await locked.execute('SELECT id FROM tasks WHERE id=%s FOR UPDATE',(full['id'],))
        read=await asyncio.wait_for(client.get('/api/fire/tasks/'+str(full['id'])),1)
        assert read.status_code==200,read.text
    (inputs/'source-data.key').write_bytes(os.urandom(32))
    with pytest.raises(BackupFailure,match='原账号'):await complete(db,full)
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM database_migration_history_imports')).fetchone())['n']==0
        assert (await(await conn.execute('SELECT count(*) n FROM database_migration_asset_imports')).fetchone())['n']==0
    assert not (settings.backup_dir/'database-migration-cutovers').exists()
    (inputs/'source-data.key').write_bytes(key)
    async with db.connection() as conn:before=(await(await conn.execute('SELECT password_hash FROM users WHERE id=%s',(full['owner_id'],))).fetchone())['password_hash']
    import alcor_api.database_migration_identity as identity
    commit=identity.complete_on_connection
    import alcor_api.database_migration_assets as asset_import
    from psycopg.errors import LockNotAvailable
    import_one=asset_import.import_one;calls=[];interrupt_asset=True
    prepare_variants=asset_import.prepare_variants;readers=0;peak=0;reader_lock=threading.Lock()
    def concurrent_originals(*args):
        nonlocal readers,peak
        with reader_lock:readers+=1;peak=max(peak,readers)
        try:
            time.sleep(.02)
            return prepare_variants(*args)
        finally:
            with reader_lock:readers-=1
    monkeypatch.setattr(asset_import,'prepare_variants',concurrent_originals)
    async def transient_lock(*args):
        nonlocal interrupt_asset
        identifier=args[5]['id'];calls.append(identifier)
        if identifier=='stock:US:TEST1' and calls.count(identifier)==1:raise LockNotAvailable('synthetic concurrent page read')
        if identifier=='stock:US:TEST9' and interrupt_asset:
            interrupt_asset=False;raise BackupFailure('synthetic unfinished asset chunk')
        return await import_one(*args)
    monkeypatch.setattr(asset_import,'import_one',transient_lock)
    async def fail_final(*args):raise BackupFailure('synthetic identity commit interruption')
    monkeypatch.setattr(identity,'complete_on_connection',fail_final)
    with pytest.raises(BackupFailure,match='synthetic unfinished asset chunk'):await complete(db,full)
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM database_migration_asset_imports')).fetchone())['n']==8
    imported_chunk_calls=calls.count('stock:US:TEST1')
    with pytest.raises(BackupFailure,match='synthetic identity'):await complete(db,full)
    assert calls.count('stock:US:TEST1')==imported_chunk_calls
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT password_hash FROM users WHERE id=%s',(full['owner_id'],))).fetchone())['password_hash']==before
        assert (await(await conn.execute('SELECT count(*) n FROM database_migration_completion_imports')).fetchone())['n']==0
        assert (await(await conn.execute('SELECT count(*) n FROM database_migration_history_imports')).fetchone())['n']==1
        assert (await(await conn.execute('SELECT count(*) n FROM database_migration_asset_imports')).fetchone())['n']==10
    assert calls.count('stock:US:TEST1')==2
    assert peak==4 and readers==0
    from alcor_api.database_migration_completion import incomplete
    interrupted=await incomplete(db,full,'synthetic interruption')
    assert interrupted['business_written'] and interrupted['history_imported']
    assert {'orders','cash','pnl','assets'}<=set(interrupted['completed_domains'])
    await finish(db,full,{'phase':'completion_incomplete','completed_stages_retained':True},error_code='synthetic')
    monkeypatch.setattr(identity,'complete_on_connection',commit)
    # A fresh TOTP replay watermark must be captured at cutover, not copied
    # back from the older preparation snapshot.
    watermark=int(time.time())//30-2
    with psycopg.connect(dsn) as original:original.execute('UPDATE ledger.users SET totp_last_step=%s',(watermark,))
    retry=await client.post(endpoint+'/complete',json=command|{'request_id':str(uuid4())});assert retry.status_code==202,retry.text
    context=(await client.get('/api/fire/database-migration/preparations/'+str(t['id'])+'/conversion')).json()
    assert {'accounts','positions','orders','cash','pnl','assets'}<=set(context['committed_domains'][str(cv['id'])])
    assert len(list((settings.backup_dir/'database-migration-cutovers').glob('*/backup-receipt.json')))==1
    calls_before=list(calls)
    original_cutover=identity.execute
    async def advance_source_after_business_snapshot(*args):
        # A credential can be used while the long business phase is running.
        # This update occurs after both business and identity connections have
        # verified their source, but before security table locks are acquired.
        with psycopg.connect(dsn) as latest:
            latest.execute('UPDATE ledger.users SET totp_last_step=%s',(watermark+1,))
            latest.execute('UPDATE ledger.passkeys SET counter=counter+1,last_used_at=1700000000999')
        return await original_cutover(*args)
    monkeypatch.setattr(identity,'execute',advance_source_after_business_snapshot)
    resumed=await claim(db,uuid4());await complete(db,resumed)
    async with db.connection() as conn:
        current=await(await conn.execute('SELECT u.*,s.totp_last_step,s.totp_secret_ciphertext FROM users u JOIN identity_security s ON s.user_id=u.id WHERE u.id=%s',(resumed['owner_id'],))).fetchone()
        assert current['username']=='RetainedOwner' and current['password_hash']==old_hash and verify_password('Retained9Pass',current['password_hash'])
        assert current['totp_last_step']==watermark+1
        profile=await(await conn.execute('SELECT bio,background_sha256 FROM user_profiles WHERE user_id=%s',(resumed['owner_id'],))).fetchone()
        assert profile['bio']=='Original bio' and profile['background_sha256']==sha(background)
        assert Vault(settings.connection_secret_dir).decrypt(current['totp_secret_ciphertext'],'totp:'+resumed['owner_id'],settings.instance_id)==secret
        key=await(await conn.execute('SELECT public_key,counter,last_used_at FROM identity_passkeys WHERE id=%s',(passkey_id,))).fetchone()
        assert bytes(key['public_key'])==cose and key['counter']==8
        assert round(key['last_used_at'].timestamp()*1000)==1700000000999
        assert (await(await conn.execute('SELECT count(*) n FROM card_custom_records WHERE owner_id=%s AND id=%s',(resumed['owner_id'],card))).fetchone())['n']==1
        assert (await(await conn.execute('SELECT count(*) n FROM database_migration_asset_imports')).fetchone())['n']==10
        assert (await(await conn.execute('SELECT count(*) n FROM portfolio_records')).fetchone())['n']==2
        result=(await(await conn.execute('SELECT result FROM database_migration_completion_imports')).fetchone())['result'];assert result['migration_complete'] and result['identity_switched']
        assert (await(await conn.execute('SELECT status FROM tasks WHERE id=%s',(resumed['id'],))).fetchone())['status']=='succeeded'
    assert calls==calls_before
    assert len(list((settings.backup_dir/'database-migration-cutovers').glob('*/backup-receipt.json')))==1
    assert (await client.get('/api/fire/session')).status_code==401
    login=await client.post('/api/session/login',json={'login':'RetainedOwner','password':'Retained9Pass'});assert login.status_code==200,login.text
    assert login.json()['status']=='requires_2fa'
    second=await client.post('/api/session/login/totp',json={'challenge_token':login.json()['challenge_token'],'code':totp_code(secret,int(time.time()))});assert second.status_code==200,second.text
    from alcor_api.database_migration_completion import verified_backup
    receipt=next((settings.backup_dir/'database-migration-cutovers').glob('*/backup-receipt.json'))
    assert (await verified_backup(settings,receipt))['archive_integrity_verified']
    (receipt.parent/'target/database.dump').write_bytes(b'corrupted archived bytes')
    with pytest.raises(BackupFailure,match='备份已变化'):await verified_backup(settings,receipt)


async def test_parallel_prepared_image_is_bound_to_original_bytes():
    from types import SimpleNamespace
    from fastapi import HTTPException
    from alcor_api.system_assets import SystemAssets,prepare_original
    raw=b'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
    prepared=prepare_original(raw,'source.svg')
    service=SystemAssets(SimpleNamespace())
    for changed,legacy in ((raw+b' ',True),(raw,False)):
        with pytest.raises(HTTPException) as failure:
            await service.apply(None,'test-owner',{'kind':'asset','folder':'stock'},'source.svg',changed,source_original=legacy,prepared_original=prepared)
        assert failure.value.status_code==400
