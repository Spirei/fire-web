import json

import pytest

from alcor_api.config import ROOT
from alcor_api.passwords import hash_password, js_length, password_error, verify_password


@pytest.mark.parametrize("case", json.loads((ROOT / "contracts/password-vectors.json").read_text())["cases"])
def test_node_vectors(case):
    assert verify_password(case["password"], case["stored"])
    assert not verify_password(case["password"] + "!", case["stored"])


def test_salt_is_text_not_hex():
    case = json.loads((ROOT / "contracts/password-vectors.json").read_text())["cases"][0]
    import hashlib

    salt, expected = case["stored"].split(":")
    assert (
        hashlib.scrypt(case["password"].encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=64).hex()
        != expected
    )


def test_length_and_malformed_hash():
    assert js_length("🛰") == 2
    assert password_error("short9")
    assert password_error("lettersOnly")
    assert not verify_password("long" * 40, "x:y")
    assert not verify_password("Synthetic9", "x:zz")
    assert verify_password("Synthetic9", hash_password("Synthetic9"))
