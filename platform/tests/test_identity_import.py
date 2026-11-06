import base64
import copy
import hashlib
from datetime import datetime, timezone
from uuid import uuid4
import cbor2
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from psycopg.conninfo import conninfo_to_dict
from alcor_api.identity_import import import_trial_snapshot
from alcor_api.passwords import hash_password, verify_password
from alcor_api.connections import Vault
from alcor_api.native_identity import totp_code, backup_hash


def snapshot():
    private=ec.generate_private_key(ec.SECP256R1())
    p=private.public_key().public_numbers()
    public=cbor2.dumps({1:2,3:-7,-1:1,-2:p.x.to_bytes(32,'big'),-3:p.y.to_bytes(32,'big')})
    data={'version':1,'source_origin':'https://legacy.example.test','passkey_config':{'enabled':True,'origin':'https://legacy.example.test','rp_id':'legacy.example.test','name':'Alcor','revision':'source-config-revision'},'users':[{'id':'source-user-001','username':'SourceAdmin','email':'source@example.invalid','password_hash':hash_password('SyntheticSource9'),'role':'admin','active':True,'created_at':'2025-01-01T00:00:00Z','email_verified':True,'totp_enabled':True,'totp_secret':'JBSWY3DPEHPK3PXP','totp_last_step':100,'totp_backup_codes':[backup_hash('abcd1234567890ef',hashlib.sha256(b'SyntheticIdentityKey9').digest())],'totp_device_name':'Source device'}],'passkeys':[{'id':'c291cmNlLWNyZWRlbnRpYWw','user_id':'source-user-001','user_handle':'c291cmNlLWhhbmRsZQ','rp_id':'legacy.example.test','public_key':base64.b64encode(public).decode(),'counter':7,'transports':['internal'],'name':'Source key','backed_up':True,'created_at':'2025-01-01T00:00:00Z','last_used_at':None}]}
    return data,private


async def test_trial_import_preserves_identity_factor_credentials_and_is_atomic(db,settings):
    data,_=snapshot(); name=conninfo_to_dict(settings.database_url.get_secret_value())['dbname']
    before=copy.deepcopy(data)
    result=await import_trial_snapshot(db,data,source_key=b'SyntheticIdentityKey9',expected_database=name)
    assert result=={'already_imported':False,'user_count':1,'key_count':1}
    assert data==before
    async with db.connection() as conn:
        user=await (await conn.execute('SELECT * FROM users')).fetchone()
        factor=await (await conn.execute('SELECT * FROM identity_security')).fetchone()
        key=await (await conn.execute('SELECT * FROM identity_passkeys')).fetchone()
        config=await (await conn.execute('SELECT * FROM identity_passkey_config')).fetchone()
        assert user['id']=='source-user-001' and user['password_hash']==data['users'][0]['password_hash']
        assert verify_password('SyntheticSource9',user['password_hash'])
        assert factor['totp_last_step']==100 and factor['backup_codes']==data['users'][0]['totp_backup_codes']
        assert factor['totp_secret_ciphertext']!='JBSWY3DPEHPK3PXP'
        assert Vault(settings.connection_secret_dir).decrypt(factor['totp_secret_ciphertext'],'totp:'+user['id'],settings.instance_id)=='JBSWY3DPEHPK3PXP'
        assert key['id']==data['passkeys'][0]['id'] and key['counter']==7 and key['user_handle']==data['passkeys'][0]['user_handle']
        assert config['rp_id']=='legacy.example.test' and config['revision']=='source-config-revision'
        assert (await (await conn.execute('SELECT bootstrap_completed FROM registration_state')).fetchone())['bootstrap_completed']
    assert (await import_trial_snapshot(db,data,source_key=b'SyntheticIdentityKey9',expected_database=name))['already_imported']


async def test_trial_import_rejects_missing_keys_wrong_target_and_ambiguous_users(db,settings):
    data,_=snapshot();name=conninfo_to_dict(settings.database_url.get_secret_value())['dbname']
    for key,target,changed in [(None,name,data),(b'SyntheticIdentityKey9','wrong-target',data),(b'SyntheticIdentityKey9',name,data|{'users':data['users']*2})]:
        with pytest.raises(ValueError):await import_trial_snapshot(db,changed,source_key=key,expected_database=target)
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM users')).fetchone())['n']==0
