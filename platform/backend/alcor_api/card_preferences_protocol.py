"""Old Web card authentication and JSON codec, including JavaScript UTF-16 edges."""

import json
import re
from urllib.parse import unquote

from fastapi import HTTPException, Response

from .card_preferences import JS_WHITESPACE
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, legacy_me_mutation_trusted, legacy_session
from .security import Identity, digest


def cookie_token(request, name):
    for part in request.headers.get('cookie', '').split(';'):
        key, separator, value = part.partition('=')
        if separator and key.strip(JS_WHITESPACE) == name:
            value = value.strip(JS_WHITESPACE)
            try:
                if re.search(r'%(?![0-9a-fA-F]{2})', value):
                    raise ValueError()
                return unquote(value, errors='strict')
            except (ValueError, UnicodeError):
                return value
    return ''


async def card_member(request, db):
    authorization = request.headers.get('authorization', '')
    bearer = authorization[7:].strip(JS_WHITESPACE) if authorization.startswith('Bearer ') else ''
    # The old card routes are outside App grant allowlists: explicit grants never fall back.
    if re.fullmatch(r'Bearer fat_[A-Za-z0-9_-]{43}', authorization):
        raise HTTPException(401, '未登录')
    token = bearer or cookie_token(request, WEB_COOKIE) or cookie_token(request, OLD_COOKIE)
    if not bearer and request.method not in ('GET', 'HEAD', 'OPTIONS') and not legacy_me_mutation_trusted(request):
        raise HTTPException(401, '未登录')
    try:
        async with db.connection() as conn:
            row = await legacy_session(conn, token, native_v1=bool(bearer))
    except HTTPException:
        raise HTTPException(401, '未登录') from None
    who = Identity(id=row['id'], username=row['username'], role=row['role'], token_hash=digest(token), csrf='', expires_at=row['expires_at'])
    who.legacy_client = True
    return who


def wire_response(value, headers, status_code=200):
    # ASCII JSON escapes retain isolated UTF-16 surrogate units exactly as JSON.stringify.
    return Response(json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False), media_type='application/json', headers=headers, status_code=status_code)
