"""Owned card labels and display holdings, independent of financial balances or card assets."""

import hashlib
import json
import math
import re
from decimal import Decimal
from urllib.parse import quote, unquote

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .security import lock_mutation_identity

JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def js_text(value):
    if value is None:
        return ''
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, list):
        return ','.join(js_text(item) for item in value)
    if isinstance(value, dict):
        return '[object Object]'
    if isinstance(value, (int, float)):
        try:
            number = float(value)
        except OverflowError:
            raise HTTPException(400, '标签格式无效') from None
        if not math.isfinite(number):
            return 'NaN' if math.isnan(number) else ('Infinity' if number > 0 else '-Infinity')
        if number == 0:
            return '0'
        if 1e-6 <= abs(number) < 1e21:
            text = format(Decimal(repr(number)), 'f')
            return text.rstrip('0').rstrip('.') if '.' in text else text
        mantissa, exponent = repr(number).lower().split('e')
        return mantissa.rstrip('0').rstrip('.') + 'e' + ('+' if int(exponent) >= 0 else '-') + str(abs(int(exponent)))
    raise HTTPException(400, '标签格式无效')


def card_key(value):
    text = js_text(value).strip(JS_WHITESPACE)
    parts = []
    for part in text.split('/'):
        try:
            if re.search(r'%(?![0-9a-fA-F]{2})', part):
                raise ValueError()
            part = unquote(part, errors='strict')
        except (ValueError, UnicodeError):
            pass
        try:
            parts.append(quote(part, safe="~()*!.'-"))
        except UnicodeError:
            raise HTTPException(400, '卡面标识无效') from None
    result = '/'.join(parts)
    if not result or len(result) > 600:
        raise HTTPException(400, '卡面标识无效')
    return result


def card_tags(value):
    if not isinstance(value, list):
        raise HTTPException(400, '标签格式无效')
    result = []
    for item in value:
        text = js_text(item).strip(JS_WHITESPACE).encode('utf-16-le', errors='surrogatepass')[:24].decode('utf-16-le', errors='surrogatepass')
        if text and text not in result:
            result.append(text)
        if len(result) == 10:
            break
    return result


def sqlite_text(value):
    # Node SQLite bindings turn unpaired UTF-16 into U+FFFD when converting to UTF-8.
    return value.encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='replace')


def persist_json(value):
    encoded = json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False)
    if re.search(r'\\u(?:0000|d[89a-f][0-9a-f]{2})', encoded):
        return {'_card_wire_json': encoded}
    return value


def restore_json(value):
    if isinstance(value, dict) and set(value) == {'_card_wire_json'}:
        return json.loads(value['_card_wire_json'])
    return value


class CardPreferences:
    def __init__(self, db):
        self.db = db

    async def authorize(self, conn, who):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('identity-management:' + who.id,))
        await lock_mutation_identity(conn, who, require_admin=False)

    async def read(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            collection = await (await conn.execute('SELECT revision FROM card_preference_collections WHERE owner_id=%s', (who.id,))).fetchone()
            tags = await (await conn.execute('SELECT card_key,tags FROM card_preference_tags WHERE owner_id=%s ORDER BY created_at,card_key', (who.id,))).fetchall()
            holdings = await (await conn.execute('SELECT card_key FROM card_preference_holdings WHERE owner_id=%s AND held ORDER BY created_at,card_key', (who.id,))).fetchall()
            positions = {row['card_key']: index for index, row in enumerate(tags)}
            tags.sort(key=lambda row: (0, int(row['card_key'])) if re.fullmatch(r'0|[1-9][0-9]{0,9}', row['card_key']) and int(row['card_key']) < 4294967295 else (1, positions[row['card_key']]))
            return {'tags': {r['card_key']: [restore_json(item) for item in r['tags']] for r in tags if r['tags']}, 'holdings': [r['card_key'] for r in holdings], 'revision': collection['revision'] if collection else 0}

    async def mutate(self, who, kind, key, value, request_id, expected=None):
        if kind not in ('tags', 'holdings'):
            raise HTTPException(400, '操作无效')
        key = card_key(key)
        if kind == 'tags':
            value = card_tags(value)
            stored_tags = [sqlite_text(item) for item in value]
            if len(set(stored_tags)) != len(stored_tags):
                # The old SQLite PK rejects collisions introduced by Node's UTF-8 conversion.
                raise HTTPException(500, 'Internal Server Error')
        elif not isinstance(value, bool):
            raise HTTPException(400, '持有标记无效')
        fingerprint = hashlib.sha256(json.dumps([kind, key, value, expected], ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            old = await (await conn.execute('SELECT * FROM card_preference_operations WHERE owner_id=%s AND request_id=%s', (who.id, request_id))).fetchone()
            if old:
                if restore_json(old['result']).get('state') == 'closed':
                    raise HTTPException(409, '原卡包请求已关闭，请查询原回执')
                if old['fingerprint'] != fingerprint:
                    raise HTTPException(409, '请求编号已用于其他修改，请查询原回执')
                return restore_json(old['result'])
            await conn.execute('INSERT INTO card_preference_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING', (who.id,))
            row = await (await conn.execute('SELECT revision FROM card_preference_collections WHERE owner_id=%s FOR UPDATE', (who.id,))).fetchone()
            if expected is not None and expected != row['revision']:
                raise HTTPException(409, '卡包偏好已变化，请重新读取')
            if kind == 'tags':
                await conn.execute('INSERT INTO card_preference_tags(owner_id,card_key,tags) VALUES(%s,%s,%s) ON CONFLICT(owner_id,card_key) DO UPDATE SET tags=excluded.tags,created_at=clock_timestamp()', (who.id, key, Jsonb([persist_json(item) for item in stored_tags])))
                payload = {'cardKey': key, 'tags': value}
            else:
                await conn.execute('INSERT INTO card_preference_holdings(owner_id,card_key,held) VALUES(%s,%s,%s) ON CONFLICT(owner_id,card_key) DO UPDATE SET held=excluded.held,created_at=CASE WHEN NOT card_preference_holdings.held AND excluded.held THEN clock_timestamp() ELSE card_preference_holdings.created_at END', (who.id, key, value))
                payload = {'cardKey': key, 'held': value}
            revision = row['revision'] + 1
            await conn.execute('UPDATE card_preference_collections SET revision=%s WHERE owner_id=%s', (revision, who.id))
            result = {'requestId': str(request_id), 'revision': revision, 'data': payload}
            await conn.execute('INSERT INTO card_preference_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)', (who.id, request_id, fingerprint, Jsonb(persist_json(result))))
            await conn.execute("INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,%s,%s)", (who.id, 'cards.' + kind + '.updated', request_id))
            return result

    async def receipt(self, who, request_id):
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            row = await (await conn.execute('SELECT result FROM card_preference_operations WHERE owner_id=%s AND request_id=%s', (who.id, request_id))).fetchone()
            if not row:
                raise HTTPException(404, '回执不存在')
            return restore_json(row['result'])

    async def close(self, who, request_id):
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            row = await (await conn.execute('SELECT result FROM card_preference_operations WHERE owner_id=%s AND request_id=%s', (who.id, request_id))).fetchone()
            if row:
                return restore_json(row['result'])
            result = {'requestId': str(request_id), 'state': 'closed', 'executed': False}
            await conn.execute('INSERT INTO card_preference_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)', (who.id, request_id, hashlib.sha256(b'closed-card-preference-request-v1').hexdigest(), Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'cards.request.closed',%s)", (who.id, request_id))
            return result
