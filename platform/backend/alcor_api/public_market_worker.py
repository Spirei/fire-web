"""Explicit public collection, with independent admission, originals and licenses."""

from dataclasses import asdict
from datetime import datetime
from hashlib import sha256
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .dividend_source_transport import ResponseFailure
from .dividend_sources import Target
from .market_authority import query_from
from .market_transport import Transport
from .market_worker import decode
from .public_market_authority import PublicAuthority

MAX_ORIGINAL = 2 * 1024 * 1024


def adapter_policy(policy):
    # collect/display are public license rights, not personal collection purposes.
    # Translate only after current(public collect) has authorized this admission.
    return SimpleNamespace(id=policy.id, source=policy.source, source_version=policy.source_version,
        target_id=policy.target_id, target_fingerprint=policy.target_fingerprint,
        license_revision=policy.license_revision, markets=policy.markets, purposes=('latest',),
        fixture=policy.fixture, source_symbols=policy.source_symbols)


def target_current(db, policy):
    if policy.fixture:
        if db.settings.environment != 'test':
            raise HTTPException(503, '公共测试来源不可用于真实实例')
        return
    try:
        targets = [Target(**raw) for raw in db.settings.public_market_source_targets if raw.get('id') == policy.target_id]
        if len(targets) != 1 or targets[0].source != policy.source or targets[0].fingerprint != policy.target_fingerprint:
            raise ValueError('public_target_changed')
        targets[0].validate(db.settings.environment)
    except (ValueError, TypeError):
        raise HTTPException(503, '公共来源固定目标已变化') from None


def from_settings(db):
    def policies():
        return db.settings.public_market_data_policies

    def targets():
        values = [Target(**raw) for raw in db.settings.public_market_source_targets]
        if len({target.id for target in values}) != len(values):
            raise ValueError("ambiguous_public_target")
        return tuple(values)

    return PublicAuthority(db, policy_provider=policies), Transport(db, target_provider=targets)


async def claim(authority, worker_id):
    """Expired work becomes unknown; it is never silently fetched a second time."""
    async with authority.db.connection() as conn, conn.transaction():
        await conn.execute("""UPDATE public_market_tasks SET status='unknown',finished_at=clock_timestamp(),
            error_code='lease_expired_no_automatic_retry' WHERE status='running' AND lease_until<=clock_timestamp()""")
        task = await (await conn.execute("""SELECT * FROM public_market_tasks WHERE status='queued'
            AND attempts=0 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1""")).fetchone()
        if not task:
            return None
        try:
            query = query_from(task['query'])
            _, policy = await authority.current(conn, task['license_id'], 'collect', query)
            target_current(authority.db, policy)
        except HTTPException:
            await conn.execute("""UPDATE public_market_tasks SET status='cancelled',finished_at=clock_timestamp(),
                error_code='public_permission_unavailable' WHERE id=%s""", (task['id'],))
            return None
        return await (await conn.execute("""UPDATE public_market_tasks SET status='running',attempts=1,
            lease_owner=%s,lease_until=clock_timestamp()+interval '45 seconds' WHERE id=%s RETURNING *""",
            (str(worker_id), task['id']))).fetchone()


async def finish(authority, task, state, code=None):
    async with authority.db.connection() as conn, conn.transaction():
        await conn.execute("""UPDATE public_market_tasks SET status=%s,error_code=%s,finished_at=clock_timestamp()
            WHERE id=%s AND status='running' AND lease_owner=%s""",
            (state, code, task['id'], task['lease_owner']))
    return state


async def retain(authority, task, policy, raw, representation, status, complete, issues):
    """Archival of an admitted response is independent of later display/IO rights."""
    async with authority.db.connection() as conn, conn.transaction():
        bound = await (await conn.execute("""SELECT t.*,l.origin_instance,l.policy_fingerprint
            FROM public_market_tasks t JOIN public_market_licenses l ON l.id=t.license_id
            WHERE t.id=%s FOR UPDATE OF t""", (task['id'],))).fetchone()
        if (not bound or bound['license_id'] != task['license_id'] or bound['query'] != task['query']
                or str(bound['origin_instance']) != str(authority.db.settings.instance_id)
                or bound['policy_fingerprint'] != policy.fingerprint):
            raise HTTPException(409, '公共来源原件与入场许可不一致')
        identifier = uuid4()
        await conn.execute("""INSERT INTO public_market_pages(id,task_id,raw_bytes,raw_sha256,
            representation,http_status,complete,issues) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT(task_id) DO NOTHING""", (identifier, task['id'], raw, sha256(raw).hexdigest(),
            representation, status, complete, Jsonb(issues)))
        return await (await conn.execute('SELECT * FROM public_market_pages WHERE task_id=%s',
                                         (task['id'],))).fetchone()


async def execute(authority, task, transport):
    if not task:
        return 'idle'
    query = query_from(task['query'])
    async with authority.db.connection() as conn, conn.transaction():
        current = await (await conn.execute('SELECT * FROM public_market_tasks WHERE id=%s FOR UPDATE',
                                           (task['id'],))).fetchone()
        if not current or current['status'] != 'running' or current['lease_owner'] != task['lease_owner']:
            return 'lost'
        archived = await (await conn.execute('SELECT 1 FROM public_market_pages WHERE task_id=%s',
                                             (task['id'],))).fetchone()
        if archived:
            await conn.execute("""UPDATE public_market_tasks SET status='unknown',finished_at=clock_timestamp(),
                error_code='original_retained_no_automatic_retry' WHERE id=%s""", (task['id'],))
            return 'unknown'
        try:
            _, policy = await authority.current(conn, task['license_id'], 'collect', query)
            target_current(authority.db, policy)
        except HTTPException:
            await conn.execute("""UPDATE public_market_tasks SET status='cancelled',finished_at=clock_timestamp(),
                error_code='public_permission_unavailable' WHERE id=%s""", (task['id'],))
            return 'cancelled'

    raw, representation, http_status, complete = None, 'source_response', None, True
    issues, facts = [], []
    try:
        raw, representation = await transport.read(adapter_policy(policy), query, None)
    except ResponseFailure as error:
        if type(error.status) is not int or not 100 <= error.status <= 599 or type(error.complete) is not bool:
            return await finish(authority, task, 'unknown', 'public_response_metadata_invalid')
        raw, http_status, complete = error.raw, error.status, error.complete
        representation = 'http_response_body'
        issues = [{'reason': 'source_http_or_size_error', 'httpStatus': http_status, 'complete': complete}]
    except Exception:  # noqa: BLE001 - source exceptions can contain credentials
        return await finish(authority, task, 'unknown', 'public_source_outcome_unknown')
    if not isinstance(raw, bytes):
        return await finish(authority, task, 'failed', 'public_source_protocol_invalid')
    if len(raw) > MAX_ORIGINAL:
        raw, complete = raw[:MAX_ORIGINAL], False
        issues.append({'reason': 'bounded_incomplete_original'})
    if not isinstance(representation, str) or len(representation) > 128:
        representation = 'source_response'
    if not issues and complete:
        try:
            facts, issues, cursor = decode(policy, query, raw)
            if cursor is not None or len(facts) != 1:
                issues.append({'reason': 'latest_response_not_one_complete_observation'})
        except Exception:  # noqa: BLE001 - retain original without source exception text
            issues = [{'reason': 'source_decode_failed'}]
    page = await retain(authority, task, policy, raw, representation, http_status, complete, issues)
    if issues or not complete:
        return await finish(authority, task, 'failed', 'public_original_retained_not_published')

    async with authority.db.connection() as conn, conn.transaction():
        current = await (await conn.execute('SELECT * FROM public_market_tasks WHERE id=%s FOR UPDATE',
                                           (task['id'],))).fetchone()
        if (not current or current['status'] != 'running' or current['lease_owner'] != task['lease_owner']
                or current['query'] != task['query']):
            return 'lost'
        try:
            _, active = await authority.current(conn, task['license_id'], 'collect', query)
            target_current(authority.db, active)
            if active.fingerprint != policy.fingerprint:
                raise HTTPException(403, '公共许可已变化')
        except HTTPException:
            await conn.execute("""UPDATE public_market_tasks SET status='cancelled',finished_at=clock_timestamp(),
                error_code='public_permission_changed_original_retained' WHERE id=%s""", (task['id'],))
            return 'cancelled'
        fact = facts[0]
        at = datetime.fromisoformat(fact['at'])
        now = (await (await conn.execute('SELECT clock_timestamp() AS at')).fetchone())['at']
        if at.tzinfo is None or (at-now).total_seconds() > 5:
            await conn.execute("""UPDATE public_market_tasks SET status='failed',finished_at=clock_timestamp(),
                error_code='public_source_time_invalid' WHERE id=%s""", (task['id'],))
            return 'failed'
        await conn.execute("""INSERT INTO public_market_facts(id,task_id,page_id,license_id,query,source_time,contents)
            VALUES(%s,%s,%s,%s,%s,%s,%s)""", (uuid4(), task['id'], page['id'], task['license_id'],
            Jsonb(asdict(query)), at, Jsonb(fact)))
        await conn.execute("""UPDATE public_market_tasks SET status='completed',finished_at=clock_timestamp()
            WHERE id=%s""", (task['id'],))
    return 'completed'


async def cycle(db, worker_id):
    authority, transport = from_settings(db)
    task = await claim(authority, worker_id)
    return await execute(authority, task, transport)
