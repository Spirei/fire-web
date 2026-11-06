"""Compatibility with fire-web/lib/password.ts; salt is UTF-8 text, not decoded hex."""

import hashlib
import hmac
import re
import secrets


def js_length(value: str) -> int:
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def password_error(value: str) -> str | None:
    if not 8 <= js_length(value) <= 128:
        return "密码须为 8–128 位"
    if not re.search("[A-Za-z]", value) or not re.search("[0-9]", value):
        return "密码须同时包含字母和数字"
    return None


def derive(value: str, salt: str) -> bytes:
    # Node uses UTF-8 replacement for unmatched UTF-16 surrogates. Reject these at API validation.
    return hashlib.scrypt(value.encode("utf-8"), salt=salt.encode("utf-8"), n=16384, r=8, p=1, dklen=64)


def hash_password(value: str) -> str:
    if password_error(value):
        raise ValueError(password_error(value))
    salt = secrets.token_hex(16)
    return salt + ":" + derive(value, salt).hex()


def verify_password(value: str, stored: str) -> bool:
    if js_length(value) > 128 or len(stored) > 256:
        return False
    pieces = stored.split(":")
    if len(pieces) != 2 or not pieces[0] or not re.fullmatch(r"[0-9a-fA-F]{128}", pieces[1]):
        return False
    try:
        return hmac.compare_digest(derive(value, pieces[0]), bytes.fromhex(pieces[1]))
    except (UnicodeError, ValueError):
        return False


DUMMY_HASH = "0" * 32 + ":" + derive("AlcorDummy123", "0" * 32).hex()
