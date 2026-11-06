"""Explicit imported manual FIRE observations; never recompute historical FX or amounts."""

import hashlib
import json
import math
from collections import Counter
from copy import deepcopy
from datetime import datetime
from decimal import Decimal
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fire_planning import CURRENCIES, merge_plan, valid_amount
from .market_contract import canonical


def exact(value):
    if type(value) is float:
        if not math.isfinite(value):
            raise HTTPException(422, '规划数字须为有限值')
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: exact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [exact(item) for item in value]
    return value


def encoded(value):
    try:
        return canonical(exact(value))
    except (ValueError, TypeError, UnicodeError):
        raise HTTPException(422, '规划原始内容无效') from None


def observations(value):
    if not isinstance(value, list) or len(value) > 1500:
        raise HTTPException(422, '资产观察须为不超过1500条的完整列表')
    result = []
    identities = {}
    for item in value:
        if (not isinstance(item, dict) or not isinstance(item.get('recordedAt'), str)
                or not valid_amount(item.get('amountBase')) or not valid_amount(item.get('amountUsd'))
                or item.get('currency') not in CURRENCIES):
            raise HTTPException(422, '资产观察的原时间、金额或币种缺失')
        try:
            datetime.fromisoformat(item['recordedAt'])
        except ValueError:
            raise HTTPException(422, '资产观察原时间无效') from None
        signature = encoded(item)
        if item.get('id') is not None:
            if not isinstance(item['id'], str) or not 1 <= len(item['id']) <= 200:
                raise HTTPException(422, '资产观察原编号无效')
            if item['id'] in identities and identities[item['id']] != signature:
                raise HTTPException(409, '同一历史观察编号对应不同原文，不能覆盖')
            identities[item['id']] = signature
        result.append(deepcopy(item))
    return result


def past_rows(value, year):
    result = {}
    rows = value.get('tableRows', [])
    if not isinstance(rows, list) or len(rows) > 500:
        raise HTTPException(422, '规划年份表须为不超过500行的列表')
    for row in rows:
        if not isinstance(row, dict):
            raise HTTPException(422, '规划年份行无效')
        try:
            number = Decimal(str(row['year']))
            if not number.is_finite():
                raise ValueError()
        except (KeyError, ValueError, ArithmeticError):
            raise HTTPException(422, '规划年份缺失或无效') from None
        if number >= year:
            continue
        if number in result and encoded(result[number]) != encoded(row):
            raise HTTPException(409, '历史年份存在不同原文，不能猜测保留哪行')
        result[number] = row
    return result


def plan_transfer(stored, incoming, current_year):
    if not isinstance(stored, dict) or not isinstance(incoming, dict):
        raise HTTPException(422, '规划导入须为对象')
    if len(encoded(incoming).encode()) > 256 * 1024:
        raise HTTPException(413, '规划原文超过256KiB')
    prior = observations(stored.get('assetHistory', []))
    proposed = observations(incoming.get('assetHistory', []))
    frozen, imported = past_rows(stored, current_year), past_rows(incoming, current_year)
    for year in set(frozen) & set(imported):
        if encoded(frozen[year]) != encoded(imported[year]):
            raise HTTPException(409, '已有历史年份不可被导入文件改写')
    if frozen and 'baseCurrency' in incoming and incoming['baseCurrency'] != stored.get('baseCurrency'):
        raise HTTPException(409, '已有历史年份时不能改写其原币基准')
    # The old format has no observation ID. Retain distinct observations even at
    # the same time; multiset union avoids inventing IDs or duplicating a replay.
    counts = Counter(encoded(item) for item in prior)
    seen = Counter()
    merged = list(prior)
    ids = {item['id']: encoded(item) for item in prior if item.get('id') is not None}
    added = 0
    for item in proposed:
        signature = encoded(item)
        if item.get('id') in ids and ids[item['id']] != signature:
            raise HTTPException(409, '已有历史观察编号不能改写金额或时间')
        seen[signature] += 1
        if seen[signature] > counts[signature]:
            merged.append(item)
            added += 1
    if len(merged) > 1500:
        raise HTTPException(409, '合并会超过1500条；原历史保留，未裁剪或覆盖')
    value = merge_plan(stored, {**deepcopy(stored), **deepcopy(incoming)}, current_year)
    value['assetHistory'] = sorted(merged, key=lambda item: item['recordedAt'])
    if len(encoded(value).encode()) > 256 * 1024:
        raise HTTPException(413, '合并后的规划超过256KiB；未丢弃原历史')
    return {'fire': value, 'importedObservations': added, 'retainedObservations': len(prior),
            'historicalRowsRetained': len(frozen), 'source': 'owner_imported_manual_observations',
            'historicalFxRecomputed': False}


async def import_on_connection(conn, who, request_id, expected_revision, incoming):
    from .account_signals import guard
    from .security import lock_mutation_identity

    try:
        request_id = str(UUID(str(request_id)))
    except (ValueError, TypeError):
        raise HTTPException(422, '规划导入原UUID无效') from None
    if type(expected_revision) is not int or expected_revision < 0:
        raise HTTPException(422, '规划导入版本无效')
    fingerprint = hashlib.sha256(encoded({
        'kind': 'personal-history-import', 'revision': expected_revision, 'fire': incoming,
    }).encode()).hexdigest()
    await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',
                       ('identity-management:' + who.id,))
    await conn.execute('SELECT id FROM users WHERE id=%s FOR UPDATE', (who.id,))
    await lock_mutation_identity(conn, who, require_admin=False)
    await guard(conn, who, 'portfolio.write')
    previous = await (await conn.execute(
        'SELECT fingerprint,result FROM fire_planning_operations WHERE owner_id=%s AND request_id=%s',
        (who.id, request_id),
    )).fetchone()
    if previous:
        if previous['fingerprint'] != fingerprint:
            raise HTTPException(409, '原UUID已用于其他规划操作')
        return previous['result']
    row = await (await conn.execute(
        'SELECT value::text AS original,revision FROM fire_planning_settings WHERE owner_id=%s FOR UPDATE',
        (who.id,),
    )).fetchone()
    revision = row['revision'] if row else 0
    if revision != expected_revision:
        raise HTTPException(409, '规划或历史已变化，请重新预览')
    stored = json.loads(row['original'], parse_float=Decimal) if row else {}
    planned = plan_transfer(stored, incoming, datetime.now(ZoneInfo('Asia/Shanghai')).year)
    await conn.execute(
        'INSERT INTO fire_planning_settings(owner_id,value) VALUES(%s,%s) '
        'ON CONFLICT(owner_id) DO UPDATE SET value=excluded.value,revision=fire_planning_settings.revision+1,updated_at=clock_timestamp()',
        (who.id, Jsonb(planned['fire'], dumps=encoded)),
    )
    result = {'ok': True, 'requestId': request_id, 'state': 'completed', 'revision': revision + 1,
              **{key: value for key, value in planned.items() if key != 'fire'},
              'assetHistory': planned['fire']['assetHistory']}
    # Receipts use exact decimal text consistently on first response and replay.
    result = json.loads(encoded(result), parse_float=str)
    await conn.execute(
        'INSERT INTO fire_planning_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',
        (who.id, request_id, fingerprint, Jsonb(result, dumps=encoded)),
    )
    await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'fire-planning.history-imported',%s,%s)",
                       (who.id, who.id, request_id))
    return result
