"""Bounded read-time verification of immutable history against its original pages."""

import asyncio
import sys
from collections import Counter, OrderedDict
from contextvars import ContextVar
from datetime import datetime
from functools import wraps
from hashlib import sha256
from threading import Lock

from fastapi import HTTPException

from .market_authority import query_from
from .market_contract import digest, series_fingerprint
from .market_worker import decode
from .request_timing import elapsed, measure, start

# Only indexes of decoded immutable bodies are reused. This contains no login,
# license decision, selected facts or quote DTO, and never skips hashing the
# actual retained bytes or checking their current references.
_indexes = OrderedDict()
_index_lock = Lock()
_index_bytes = 0
_MAX_PAGES = 512
_MAX_INDEX_BYTES = 32 * 1024 * 1024
_admission = ContextVar('history_read_admission', default=None)


def _gate(name, capacity):
    loop = asyncio.get_running_loop()
    gate = getattr(loop, name, None)
    if gate is None:
        gate = asyncio.Semaphore(capacity)
        setattr(loop, name, gate)
    return gate


def bounded_history_read(function):
    """Admit at most four retained-body readers before allocating any originals."""
    @wraps(function)
    async def admitted(*args, **kwargs):
        gate = _gate('_alcor_history_read_gate', 4)
        try:
            with measure("history_admission"):
                await asyncio.wait_for(gate.acquire(), 3)
        except TimeoutError:
            raise HTTPException(503, '历史读取繁忙，请稍后重试', headers={'Retry-After': '1'}) from None
        jobs = []
        token = _admission.set(jobs)
        try:
            return await function(*args, **kwargs)
        finally:
            _admission.reset(token)
            running = [job for job in jobs if not job.done()]
            if running:
                # A cancelled reader must not free the retained-body permit
                # while its pure worker still owns those bytes.
                remaining = set(running)
                def finished(job):
                    remaining.discard(job)
                    if not remaining:
                        gate.release()
                for job in running:
                    job.add_done_callback(finished)
            else:
                gate.release()
    return admitted


def _decoded_index(owner, revision, page, policy, query, raw, checksum):
    global _index_bytes
    policy_key = getattr(policy, 'fingerprint', None) or digest(vars(policy))
    key = (owner, str(revision), policy_key, digest(page['source_query']),
           digest(page['cursor_in']), checksum)
    with _index_lock:
        existing = _indexes.get(key)
        if existing is not None:
            _indexes.move_to_end(key)
            return existing[0]
    decoded, _, _ = decode(policy, query, raw, cursor_in=page['cursor_in'])
    proved = Counter(digest(value) for value in decoded)
    size = (sys.getsizeof(proved) + sys.getsizeof(key)
            + sum(sys.getsizeof(part) for part in key)
            + sum(sys.getsizeof(fingerprint) + sys.getsizeof(count) for fingerprint, count in proved.items()))
    if size <= _MAX_INDEX_BYTES:
        with _index_lock:
            prior = _indexes.pop(key, None)
            if prior is not None:
                _index_bytes -= prior[1]
            _indexes[key] = (proved, size)
            _index_bytes += size
            while len(_indexes) > _MAX_PAGES or _index_bytes > _MAX_INDEX_BYTES:
                _, old = _indexes.popitem(last=False)
                _index_bytes -= old[1]
    return proved


async def load_history_evidence(conn, owner, revision, rows):
    grouped = {}
    for row in rows:
        grouped.setdefault(row['page_id'], []).append(row)
    if len(grouped) > 256:
        raise HTTPException(503, '历史原件核对超过分页预算')
    pages = None
    if len(grouped) > 1:
        identifiers = list(grouped)
        # Bound bytes before fetching bodies; 256 individually valid pages can
        # still exceed the total proof budget. The caller holds repeatable read.
        size = await (await conn.execute('''SELECT COALESCE(sum(octet_length(raw_bytes)),0) AS bytes
            FROM market_source_pages WHERE owner_id=%s AND source_revision=%s AND id=ANY(%s)''',
            (owner, revision, identifiers))).fetchone()
        if size['bytes'] > 64 * 1024 * 1024:
            raise HTTPException(503, '历史事实与保留原件无法核对')
        retained = await (await conn.execute('''SELECT p.*,s.id AS source_stream_id,s.source_revision AS stream_revision,
            s.query AS source_query,t.owner_id AS task_owner
            FROM market_source_pages p JOIN market_data_jobs j ON j.task_id=p.task_id AND j.owner_id=p.owner_id
            JOIN market_streams s ON s.id=j.stream_id AND s.owner_id=j.owner_id
            JOIN tasks t ON t.id=p.task_id AND t.owner_id=p.owner_id
            WHERE p.id=ANY(%s) AND p.owner_id=%s AND p.source_revision=%s''',
            (identifiers, owner, revision))).fetchall()
        pages = {page['id']: page for page in retained}
    evidence = []
    for page_id, facts in grouped.items():
        page = pages.get(page_id) if pages is not None else await (await conn.execute('''SELECT p.*,s.id AS source_stream_id,s.source_revision AS stream_revision,
            s.query AS source_query,t.owner_id AS task_owner
            FROM market_source_pages p JOIN market_data_jobs j ON j.task_id=p.task_id AND j.owner_id=p.owner_id
            JOIN market_streams s ON s.id=j.stream_id AND s.owner_id=j.owner_id
            JOIN tasks t ON t.id=p.task_id AND t.owner_id=p.owner_id
            WHERE p.id=%s AND p.owner_id=%s AND p.source_revision=%s''', (page_id, owner, revision))).fetchone()
        evidence.append((page, facts))
    return evidence


def prove_history_evidence(owner, revision, evidence, policy):
    """Pure bounded CPU work: no database, provider, authentication or mutation."""
    total_bytes = 0
    for page, facts in evidence:
        try:
            if not page or page['task_owner'] != owner or page['stream_revision'] != revision:
                raise ValueError()
            raw = bytes(page['raw_bytes'])
            total_bytes += len(raw)
            checksum = sha256(raw).hexdigest()
            if total_bytes > 64 * 1024 * 1024 or checksum != page['raw_sha256']:
                raise ValueError()
            if (page.get('complete') is False or page.get('http_status') not in (None, 200)
                    or any(issue.get('reason') == 'source_http_or_size_error' or issue.get('complete') is False
                           or issue.get('httpStatus') not in (None, 200)
                           for issue in page['issues'] if isinstance(issue, dict))):
                raise ValueError()
            query = query_from(page['source_query'])
            proved = _decoded_index(owner, revision, page, policy, query, raw, checksum)
            series = series_fingerprint(query)
            for fact in facts:
                stamp = datetime.fromisoformat(fact['contents']['at'])
                if stamp.tzinfo is None or stamp != fact['source_time']:
                    raise ValueError()
                fingerprint = digest(fact['contents'])
                if (fact['stream_id'] != page['source_stream_id'] or fact['series_fingerprint'] != series
                        or fact['source_revision'] != revision or fingerprint != fact['fingerprint']
                        or proved[fingerprint] != 1):
                    raise ValueError()
        except (ValueError, TypeError, KeyError, OverflowError, UnicodeError, RecursionError):
            raise HTTPException(503, '历史事实与保留原件无法核对') from None


async def verify_history_evidence(owner, revision, evidence, policy, *, short=False):
    # Per-loop admission avoids binding test/server loops together. The permit
    # belongs to the actual job, so a cancelled HTTP reader cannot start extra
    # CPU work while its abandoned proof is still finishing.
    gate = _gate('_alcor_latest_proof_gate' if short else '_alcor_history_proof_gate', 2)
    waiting = start()
    await gate.acquire()
    elapsed('history_proof_wait', waiting)
    job = asyncio.create_task(asyncio.to_thread(prove_history_evidence, owner, revision, evidence, policy))
    jobs = _admission.get()
    if jobs is not None:
        jobs.append(job)
    def completed(result):
        gate.release()
        if not result.cancelled():
            result.exception()
    job.add_done_callback(completed)
    with measure('history_proof'):
        await asyncio.shield(job)


async def verify_history_rows(conn, owner, revision, rows, policy):
    evidence = await load_history_evidence(conn, owner, revision, rows)
    # Discovery verifies single bounded latest pages while holding its own read
    # transaction. It must not wait behind long historical RT decoding jobs.
    short = len(evidence) <= 1 and all(page and page['source_query'].get('kind') == 'latest'
        and len(page['raw_bytes']) <= 131072 for page, _ in evidence)
    await verify_history_evidence(owner, revision, evidence, policy, short=short)
