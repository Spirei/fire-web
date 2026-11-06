import base64
import hashlib
import json
import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from alcor_api.config import ROOT
from alcor_api.native_identity import totp_code, verify_totp, backup_hash, consume_backup, decode_legacy_secret

VECTORS = json.loads((ROOT/'contracts/identity/legacy-totp-vectors.json').read_text())

@pytest.mark.parametrize('case', VECTORS['cases'])
def test_legacy_node_totp_vectors(case):
    assert totp_code(VECTORS['secret'], case['time']) == case['code']
    step = case['time']//30
    assert verify_totp(VECTORS['secret'], case['code'], seconds=case['time']) == step
    assert verify_totp(VECTORS['secret'], case['code'], step, seconds=case['time']) is None


def test_source_backup_codes_remain_usable_once_without_rebinding():
    key = hashlib.sha256(b'SyntheticIdentityKey9').digest()
    vector = VECTORS['backup']
    assert backup_hash(vector['code'], key) == vector['digest']
    old = hashlib.sha256(b'abcd1234567890ef').hexdigest()
    for digest in [old, vector['digest']]:
        accepted, remaining = consume_backup(vector['code'], [digest], key)
        assert accepted and remaining == []
        assert consume_backup(vector['code'], remaining, key) == (False, [])
    assert not consume_backup('abcd-1234-5678-90ed', [vector['digest']], key)[0]


def test_source_aes_gcm_format_requires_original_key_and_rejects_corruption():
    key=b'SyntheticMigrationSourceKey9'
    nonce=b'123456789012'
    cipher=AESGCM(hashlib.sha256(key).digest()).encrypt(nonce,b'JBSWY3DPEHPK3PXP',None)
    envelope='enc:v1:'+':'.join(base64.b64encode(p).decode() for p in [nonce,cipher[-16:],cipher[:-16]])
    assert decode_legacy_secret(envelope,key)=='JBSWY3DPEHPK3PXP'
    for wrong in [None,b'wrong-key']:
        with pytest.raises(ValueError):decode_legacy_secret(envelope,wrong)
    with pytest.raises(ValueError):decode_legacy_secret(envelope[:-2],key)
