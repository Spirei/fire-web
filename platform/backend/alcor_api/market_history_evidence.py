"""Bounded read-time verification of immutable history against its original pages."""

from datetime import datetime
from hashlib import sha256

from fastapi import HTTPException

from .market_authority import query_from
from .market_contract import digest, series_fingerprint
from .market_worker import decode


async def verify_history_rows(conn, owner, revision, rows, policy):
    grouped = {}
    for row in rows:
        grouped.setdefault(row['page_id'], []).append(row)
    if len(grouped) > 256:
        raise HTTPException(503, '历史原件核对超过分页预算')
    total_bytes = 0
    for page_id, facts in grouped.items():
        page = await (await conn.execute('''SELECT p.*,s.id AS source_stream_id,s.source_revision AS stream_revision,
            s.query AS source_query,t.owner_id AS task_owner
            FROM market_source_pages p JOIN market_data_jobs j ON j.task_id=p.task_id AND j.owner_id=p.owner_id
            JOIN market_streams s ON s.id=j.stream_id AND s.owner_id=j.owner_id
            JOIN tasks t ON t.id=p.task_id AND t.owner_id=p.owner_id
            WHERE p.id=%s AND p.owner_id=%s AND p.source_revision=%s''', (page_id, owner, revision))).fetchone()
        try:
            if not page or page['task_owner'] != owner or page['stream_revision'] != revision:
                raise ValueError()
            raw = bytes(page['raw_bytes'])
            total_bytes += len(raw)
            if total_bytes > 64 * 1024 * 1024 or sha256(raw).hexdigest() != page['raw_sha256']:
                raise ValueError()
            if (page.get('complete') is False or page.get('http_status') not in (None, 200)
                    or any(issue.get('reason') == 'source_http_or_size_error' or issue.get('complete') is False
                           or issue.get('httpStatus') not in (None, 200)
                           for issue in page['issues'] if isinstance(issue, dict))):
                raise ValueError()
            query = query_from(page['source_query'])
            decoded, _, _ = decode(policy, query, raw, cursor_in=page['cursor_in'])
            proved = [digest(value) for value in decoded]
            series = series_fingerprint(query)
            for fact in facts:
                stamp = datetime.fromisoformat(fact['contents']['at'])
                if stamp.tzinfo is None or stamp != fact['source_time']:
                    raise ValueError()
                fingerprint = digest(fact['contents'])
                if (fact['stream_id'] != page['source_stream_id'] or fact['series_fingerprint'] != series
                        or fact['source_revision'] != revision or fingerprint != fact['fingerprint']
                        or proved.count(fingerprint) != 1):
                    raise ValueError()
        except (ValueError, TypeError, KeyError, OverflowError, UnicodeError, RecursionError):
            raise HTTPException(503, '历史事实与保留原件无法核对') from None
