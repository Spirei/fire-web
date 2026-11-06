"""Native ports of fire-web identity primitives. No legacy-server/API dependency."""
import base64
import hashlib
import hmac
import re
import struct
import time
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def decode_legacy_secret(value: str, source_key: bytes | None) -> str:
    if not value.startswith("enc:v1:"):
        return value
    if not source_key:
        raise ValueError("Source encryption key is required")
    try:
        iv, tag, payload = [base64.b64decode(p, validate=True) for p in value[7:].split(":")]
        if len(iv) != 12 or len(tag) != 16:
            raise ValueError()
        return AESGCM(hashlib.sha256(source_key).digest()).decrypt(iv, payload + tag, None).decode()
    except Exception:
        raise ValueError("Source credential could not be decrypted") from None


def totp_code(secret: str, seconds: int) -> str:
    if not re.fullmatch(r"[A-Z2-7]{16,128}", secret):
        raise ValueError("Invalid TOTP secret")
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack(">Q", seconds // 30), hashlib.sha1).digest()
    offset = mac[-1] & 15
    value = struct.unpack(">I", mac[offset:offset+4])[0] & 0x7fffffff
    return str(value % 1_000_000).zfill(6)


def verify_totp(secret: str, code: str, last_step: int = -1, *, seconds: int | None = None) -> int | None:
    cleaned = re.sub(r"\s", "", code)
    if not re.fullmatch(r"[0-9]{6}", cleaned):
        return None
    now = (int(time.time()) if seconds is None else seconds) // 30
    for step in range(max(0, now - 1), now + 2):
        if step > last_step and hmac.compare_digest(totp_code(secret, step * 30), cleaned):
            return step
    return None


def normalize_backup(code: str) -> str:
    return re.sub(r"[^a-f0-9]", "", code.strip().lower())


def backup_hash(code: str, data_key: bytes) -> str:
    return "v2:" + hmac.new(data_key, normalize_backup(code).encode(), hashlib.sha256).hexdigest()


def consume_backup(code: str, hashes: list[str], data_key: bytes) -> tuple[bool, list[str]]:
    cleaned = normalize_backup(code)
    if len(cleaned) < 8:
        return False, hashes
    current = backup_hash(code, data_key)
    legacy = hashlib.sha256(cleaned.encode()).hexdigest()
    for index, value in enumerate(hashes):
        if hmac.compare_digest(value, current if value.startswith("v2:") else legacy):
            return True, hashes[:index] + hashes[index+1:]
    return False, hashes
