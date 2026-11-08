"""Owner-scoped, read-only diagnostics projection. GET never calls a provider."""
from datetime import UTC, datetime

from .market_source_descriptors import describe_sources


LABELS = {'futu': '富途 OpenD', 'tencent': '腾讯行情', 'yahoo': 'Yahoo 行情', 'coingecko': '加密货币行情'}


def point(state, at, elapsed=None):
    return {'state': state, 'at': at.isoformat() if hasattr(at, 'isoformat') else at,
            'elapsedMs': elapsed if isinstance(elapsed, (int, float)) and elapsed >= 0 else None}


async def snapshot(app, who):
    authority = app.state.market_authority
    descriptors = await describe_sources(authority, who)
    versions = [value for value in descriptors['versions'] if value['usable']]
    if len(versions) > 30:
        from fastapi import HTTPException
        raise HTTPException(409, '来源过多，请先整理配置后再检测')
    items = []
    async with authority.db.connection() as conn, conn.transaction():
        from .security import lock_mutation_identity
        await lock_mutation_identity(conn, who, require_admin=True)
        for version in versions:
            policy = version['policy']; revision = version['revision']
            futu = policy['source'] == 'futu'
            if futu:
                rows = await (await conn.execute(
                    "SELECT result,created_at FROM market_data_operations WHERE owner_id=%s AND result->>'kind'='futu.test' AND result->>'sourceRevision'=%s ORDER BY created_at DESC LIMIT 12",
                    (who.id, revision),
                )).fetchall()
                points = [point('up' if row['result'].get('ok') is True else 'down' if row['result'].get('state') == 'unavailable' else 'unknown',
                                row['result'].get('observedAt') or row['created_at'], row['result'].get('elapsedMs')) for row in rows]
                detail = rows[0]['result'].get('message', '检测结果未知') if rows else '尚未测试连接'
            else:
                rows = await (await conn.execute(
                    'SELECT observed_at,issues FROM market_source_pages WHERE owner_id=%s AND source_revision=%s ORDER BY observed_at DESC LIMIT 12',
                    (who.id, revision),
                )).fetchall()
                points = [point('warning' if row['issues'] else 'up', row['observed_at']) for row in rows]
                detail = '最近采集结果，不代表当前连接状态' if rows else '已配置，尚无采集记录'
            items.append({'id': 'market:' + revision, 'label': LABELS.get(policy['source'], policy['source']),
                          'kind': 'broker' if futu else 'quotes', 'state': points[0]['state'] if points else 'unknown',
                          'detail': detail, 'points': list(reversed(points)), 'configured': True,
                          'sourceRevision': revision, 'canTest': futu and 'futu.test' in policy['purposes'],
                          'scope': 'connection' if futu else 'collection'})
        for kind, label in [('broker', '券商连接'), ('quotes', '行情来源')]:
            if not any(row['kind'] == kind for row in items):
                items.append({'id': kind, 'label': label, 'kind': kind, 'state': 'unconfigured',
                              'configured': False, 'canTest': False, 'points': [], 'detail': '尚未配置来源', 'scope': 'connection'})
        config = await (await conn.execute('SELECT enabled FROM fx_config WHERE singleton')).fetchone()
        rows = await (await conn.execute(
            "SELECT state,completed_at,CASE WHEN completed_at>=started_at THEN extract(epoch FROM (completed_at-started_at))*1000 END AS elapsed FROM fx_refresh_tasks WHERE owner_id=%s AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 12", (who.id,),
        )).fetchall()
        points = [point('up' if row['state'] == 'completed' else 'down', row['completed_at'], float(row['elapsed']) if row['elapsed'] is not None else None) for row in rows]
        enabled = bool(config and config['enabled'])
        items.append({'id':'fx','label':'汇率来源','kind':'fx','configured':enabled,'canTest':False,
                      'state':points[0]['state'] if points else 'unknown' if enabled else 'unconfigured',
                      'detail':'最近汇率更新任务' if points else '尚无更新记录' if enabled else '尚未启用汇率来源',
                      'points':list(reversed(points)), 'scope':'collection'})
        rows = await (await conn.execute(
            "SELECT created_at,result FROM earnings_calendar_pages WHERE owner_id=%s ORDER BY created_at DESC LIMIT 12", (who.id,),
        )).fetchall()
        points = [point('up' if row['result'].get('state') == 'observed' else 'warning', row['created_at']) for row in rows]
        configured = bool(app.state.settings.earnings_targets)
        items.append({'id':'earnings','label':'财报日历','kind':'earnings','configured':configured,'canTest':False,
                      'state':points[0]['state'] if points else 'unknown' if configured else 'unconfigured',
                      'detail':'最近财报采集结果' if points else '尚无采集记录' if configured else '尚未配置财报来源',
                      'points':list(reversed(points)), 'scope':'collection'})
    return {'items':items,'observedAt':datetime.now(UTC).isoformat(),'collectionOnRead':False}
