"""Recheck saved schedule evidence without acquiring data or authorizing a cash entry."""
import hashlib
import json
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException

from .dividend_announcements import NORMALIZER_VERSION, futu_announcement
from .dividend_sources import canonical, parse


async def verify_schedule_original(conn, row):
    try:
        raw = row['raw_payload'].encode('utf-8')
        if (not raw or len(raw)>131072 or hashlib.sha256(raw).hexdigest()!=row['raw_sha256']
                or row['captured_at'].tzinfo is None
                or row['captured_at']>datetime.now(UTC)+timedelta(seconds=5)):
            raise ValueError('original')
        if not row['source_event_id'].startswith('observation:'):
            # The manual import is explicitly owner supplied and never source verified.
            if row['source']!='futu' or row['normalizer_version']!=NORMALIZER_VERSION:
                raise ValueError('manual_source')
            normalized=futu_announcement(json.loads(raw))
            if canonical(normalized)!=canonical(row['normalized']):
                raise ValueError('manual_projection')
            return
        observations=await(await conn.execute('''SELECT p.*,o.json_pointer,o.record_fingerprint,c.config,c.source
            FROM dividend_source_observations o
            JOIN dividend_source_pages p ON (p.owner_id,p.task_id,p.cursor)=(o.owner_id,o.task_id,o.cursor)
            JOIN dividend_source_scans s ON s.task_id=p.task_id AND s.owner_id=p.owner_id
            JOIN dividend_source_configs c ON c.owner_id=s.owner_id AND c.revision=s.config_revision
            WHERE o.owner_id=%s AND o.announcement_revision=%s ORDER BY p.received_at LIMIT 65''',
            (row['owner_id'],row['revision']))).fetchall()
        if not observations or len(observations)>64:
            raise ValueError('observation_budget')
        # Repeated scans can reference the same immutable announcement. Its first
        # exact bound original suffices; later observations never change its facts.
        for page in observations:
            if (bytes(page['raw_bytes'])!=raw or page['raw_sha256']!=row['raw_sha256']
                    or page['source']!=row['source'] or page['config'].get('market')!=row['market']
                    or page['config'].get('code')!=row['code']):
                continue
            decoded=parse(page['source'],raw,page['config'],page['cursor'])
            matches=[item for item in decoded.records if item[0]==page['json_pointer']]
            if len(matches)!=1:
                continue
            pointer,source,normalized=matches[0]
            record_hash=hashlib.sha256(canonical(source).encode()).hexdigest()
            if (record_hash==page['record_fingerprint'] and row['source_event_id']=='observation:'+record_hash
                    and row['source_revision']==row['raw_sha256']+'#'+pointer
                    and normalized.get('normalizerVersion')==row['normalizer_version']
                    and decoded.timezone==row['market_timezone']
                    and canonical(json.loads(canonical(normalized),parse_float=str))==canonical(row['normalized'])):
                return
        raise ValueError('bound_original')
    except (ValueError,TypeError,KeyError,UnicodeError,OverflowError,AttributeError) as exc:
        raise HTTPException(503,'股息公告原件与解释事实无法核对') from exc
