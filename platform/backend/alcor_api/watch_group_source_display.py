"""Read only metadata provenance; source creation time never becomes a financial event."""

import json
from datetime import UTC, datetime

from fastapi import HTTPException

from .resource_import import instant
from .security import lock_mutation_identity
from .source_snapshot import canonical, sha

MAX_SOURCES = 32


def stored_text(row, key):
    cell = row.get(key, {})
    return cell.get('text') if not cell.get('null') and isinstance(cell.get('text'), str) else None


def project(source, raw, original_id):
    """Project immutable bytes, preserving unknowns and the actual old SQL keys."""
    result = {
        'sourceInstance': source['source_instance'], 'sourceOwner': source['source_owner'],
        'originalGroupId': original_id, 'manifestId': str(source['id']),
        'rawSha256': source['raw_sha256'], 'appliedRequestId': str(source['applied_request_id']),
        'platformAppliedAt': source['applied_at'].isoformat(),
        'state': 'unknown', 'sourceCreatedAt': None, 'sourceCreatedAtRaw': None,
        'timezone': None, 'legacyOrderState': 'unknown',
        'legacyOrderBy': ['sort', 'created_at'], 'legacyOrderKey': None,
        'sourceRowSha256': None,
    }
    try:
        if sha(raw) != source['raw_sha256']:
            raise ValueError()
        snapshot = json.loads(raw)
        if snapshot['source']['owner'] != source['source_owner'] or snapshot['source']['instance'] != source['source_instance']:
            raise ValueError()
        rows = snapshot['tables']['watch_groups']
        row = next(r for r in rows if stored_text(r, 'id') == original_id)
        if stored_text(row, 'user_id') != source['source_owner']:
            raise ValueError()
        result['sourceRowSha256'] = sha(canonical(row))
        created, sort = stored_text(row, 'created_at'), stored_text(row, 'sort')
        result.update(sourceCreatedAtRaw=created, timezone=snapshot['source']['timezone'])
        result['legacyOrderKey'] = {'sort': row.get('sort'), 'created_at': row.get('created_at')}
        result['legacyOrderStorage'] = snapshot['source']['kind']
        same = sum(stored_text(r, 'sort') == sort and stored_text(r, 'created_at') == created for r in rows)
        result['legacyOrderState'] = 'unknown_equal_source_keys' if same > 1 else 'stored_keys'
        # This is an optional display instant; TEXT database order must not be
        # replaced by chronological order, especially across timezone offsets.
        parsed = datetime.fromisoformat(instant(created, result['timezone'])).astimezone(UTC)
        result.update(state='known', sourceCreatedAt=parsed.isoformat())
    except (ValueError, TypeError, KeyError, StopIteration, UnicodeError):
        pass
    return result


def aggregate(sources, *, truncated=False):
    values = {r['sourceCreatedAt'] for r in sources if r['state'] == 'known'}
    state = ('unknown_truncated_sources' if truncated else
             'unknown' if not sources or any(r['state'] != 'known' for r in sources) else
             'conflict' if len(values) != 1 else 'known')
    return {'state': state, 'sourceCreatedAt': next(iter(values)) if state == 'known' else None}


class WatchGroupSourceDisplay:
    def __init__(self, db):
        self.db = db

    async def read(self, who, group_id):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('identity-management:' + who.id,))
            await lock_mutation_identity(conn, who, require_admin=False)
            user = await (await conn.execute('SELECT active,role FROM users WHERE id=%s', (who.id,))).fetchone()
            if not user or not user['active'] or user['role'] != who.role:
                raise HTTPException(403, '账号权限已变化', headers={'X-Alcor-Retire-Context': 'true'})
            group = await (await conn.execute('SELECT id,created_at FROM watch_groups WHERE owner_id=%s AND id=%s AND deleted_at IS NULL', (who.id, group_id))).fetchone()
            if not group:
                raise HTTPException(404, '本人分组不存在')
            installed = await (await conn.execute("SELECT to_regclass('watch_group_source_bindings') name")).fetchone()
            sources, total = [], 0
            if installed['name']:
                count = await (await conn.execute('SELECT count(*) n FROM watch_group_source_bindings WHERE owner_id=%s AND target_group_id=%s', (who.id, group_id))).fetchone()
                total = count['n']
                rows = await (await conn.execute("""
                    SELECT b.original_group_id,b.source_instance,b.source_owner,
                      latest.id,latest.raw,latest.raw_sha256,latest.applied_request_id,latest.applied_at
                    FROM watch_group_source_bindings b
                    LEFT JOIN LATERAL (
                      SELECT m.id,m.raw,m.raw_sha256,o.request_id applied_request_id,o.created_at applied_at
                      FROM watch_group_import_operations o JOIN watch_group_source_manifests m
                        ON m.owner_id=o.owner_id AND m.id=(o.result->>'manifestId')::uuid
                      WHERE o.owner_id=b.owner_id AND o.kind='apply' AND o.state='completed'
                        AND m.source_instance=b.source_instance AND m.source_owner=b.source_owner
                        AND o.result->'groupMap'->>b.original_group_id=b.target_group_id
                      ORDER BY o.created_at DESC,o.request_id DESC LIMIT 1
                    ) latest ON true
                    WHERE b.owner_id=%s AND b.target_group_id=%s
                    ORDER BY b.source_instance,b.source_owner,b.original_group_id LIMIT %s
                """, (who.id, group_id, MAX_SOURCES))).fetchall()
                for row in rows:
                    if row['id'] is None:
                        sources.append({'sourceInstance': row['source_instance'], 'sourceOwner': row['source_owner'], 'originalGroupId': row['original_group_id'], 'state': 'unknown', 'sourceCreatedAt': None, 'reason': 'applied_source_receipt_missing'})
                    else:
                        sources.append(project(row, bytes(row['raw']), row['original_group_id']))
            state = aggregate(sources, truncated=total > len(sources)) if total else {'state': 'not_imported', 'sourceCreatedAt': None}
            return {
                'groupId': group_id, 'platformCreatedAt': group['created_at'].isoformat(),
                **state, 'sourceCount': total, 'sources': sources, 'sourcesTruncated': total > len(sources),
                'projectionRevision': sha(canonical(sources)),
                'selection': 'last_explicit_successful_apply_per_exact_source_binding',
                'legacyDtoFields': ['id', 'name', 'icon', 'sort', 'visible', 'kind', 'market'],
                'legacyDtoContainsCreatedAt': False,
                'legacyOrderBy': ['sort', 'created_at'],
                'sourceTimeUse': 'display_metadata_only',
            }
