"""Conservative catalogue retirement plan; original files are never removed."""

from fastapi import HTTPException
from psycopg import sql


CONSUMERS = (
    'watch_groups', 'watch_display_fields', 'card_custom_records',
    'card_catalog_public_index', 'card_preference_tags', 'card_preference_holdings',
    'card_wallet_accounts', 'card_wallet_details', 'celeb_revisions', 'site_settings',
)


async def cleanup_candidates(conn, selection):
    ids = selection.get('ids')
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 200
            or any(not isinstance(value, str) for value in ids) or len(set(ids)) != len(ids)):
        raise HTTPException(400, '清理须明确选中1至200个目录项目')
    candidates = []
    for aid in ids:
        entry = await (await conn.execute(
            'SELECT * FROM asset_catalog_entries WHERE id=%s', (aid,),
        )).fetchone()
        if not entry:
            raise HTTPException(409, '清理目标已变化')
        references = dict(await (await conn.execute('''SELECT
          (SELECT count(*) FROM asset_catalog_aliases a JOIN asset_catalog_image_keys k
           ON k.key=a.key WHERE k.asset_id=%s) AS aliases,
          (SELECT count(*) FROM portfolio_records WHERE %s='stock' AND market=%s AND code=%s) AS records,
          (SELECT count(*) FROM internal_orders WHERE %s='stock' AND record_market=%s AND record_code=%s) AS orders''',
            (aid, entry['type'], entry['market'], entry['code'],
             entry['type'], entry['market'], entry['code']),
        )).fetchone())
        keys = await (await conn.execute(
            'SELECT key FROM asset_catalog_image_keys WHERE asset_id=%s ORDER BY key', (aid,),
        )).fetchall()
        versions = [str(entry[key]) for key in ('light_version', 'dark_version') if entry[key]]
        paths = await (await conn.execute(
            'SELECT public_path FROM system_asset_versions WHERE id=ANY(%s::uuid[]) ORDER BY public_path',
            (versions,),
        )).fetchall() if versions else []
        markers = sorted({aid, *versions, *(row['public_path'] for row in paths),
                          *('/api/asset-image/' + row['key'] for row in keys)})
        # Substring matching is conservative: an ambiguous reference retains the
        # directory entry. No private values leave this connection, only counts.
        for table in CONSUMERS:
            query = sql.SQL('SELECT count(*) AS n FROM {} t WHERE EXISTS ('
                            'SELECT 1 FROM unnest(%s::text[]) m(value) '
                            'WHERE position(m.value in to_jsonb(t)::text)>0)').format(sql.Identifier(table))
            references[table] = (await (await conn.execute(query, (markers,))).fetchone())['n']
        candidates.append({
            'id': aid, 'type': entry['type'], 'market': entry['market'], 'code': entry['code'],
            'name': entry['name'], 'sourceId': str(entry['source_id']),
            'lightVersion': str(entry['light_version']) if entry['light_version'] else None,
            'darkVersion': str(entry['dark_version']) if entry['dark_version'] else None,
            'references': references, 'eligible': not any(references.values()),
            'evidence': 'explicit_catalogue_reference_graph', 'filesWillBeDeleted': False,
        })
    return {'candidates': candidates,
            'scope': ['aliases', 'portfolio_records_including_history', 'internal_orders', *CONSUMERS],
            'retainsOriginals': True, 'physicalFileDeletion': False}
