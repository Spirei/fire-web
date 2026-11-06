"""First-owner ordinary GET creates neither cash nor record collection zero rows."""

from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES
from alcor_api.backups import tables_and_hashes
from alcor_api.source_read_access import source_read_lock
from fastapi import HTTPException


async def snapshot(db):
    async with db.connection() as conn, conn.transaction():
        values = await tables_and_hashes(conn)
    # The independent recorder flushes request telemetry during slower CI runs.
    # All source originals, financial tables, preferences and receipts stay in
    # this comparison; only independently flushed request observation tables differ.
    telemetry = REQUEST_TELEMETRY_TABLES
    return {name: value for name, value in values.items() if name not in telemetry}


async def test_first_user_all_source_history_reads_leave_every_business_PG_table_unchanged(client, admin, app):
    before = await snapshot(app.state.db)
    for path, status in [('/api/legacy-financial/authorizations', 200), ('/api/legacy-financial/coverage', 200), ('/api/legacy-financial/export-budget', 200), ('/api/legacy-financial/operations/'+str(uuid4()), 404), ('/api/legacy-financial/manifests/'+str(uuid4()), 404), ('/api/legacy-financial/manifests/'+str(uuid4())+'/raw', 404), ('/api/legacy-financial/mappings', 200), ('/api/legacy-financial/mappings/operations/'+str(uuid4()), 404), ('/api/financial-import/operations/'+str(uuid4()), 404)]:
        assert any(getattr(r, 'path', '') not in ('/{path:path}', '/api/{path:path}') and 'GET' in getattr(r, 'methods', ()) and r.path_regex.match(path) for r in app.router.routes), path
        response = await client.get(path)
        assert response.status_code == status, (path, response.text)
        assert await snapshot(app.state.db) == before, path
    async with app.state.db.connection() as conn:
        for table in ('cash_ledger_collections', 'portfolio_record_collections'):
            assert (await (await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n'] == 0


async def test_current_role_session_and_owner_remain_enforced_for_read_only_lock(client, admin, app):
    from alcor_api.security import COOKIE, digest

    async with app.state.db.connection() as conn:
        user = await (await conn.execute('SELECT u.*,s.token_hash FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=%s', (digest(client.cookies[COOKIE]),))).fetchone()
        who = SimpleNamespace(id=admin, role='different-role', token_hash=user['token_hash'])
        with pytest.raises(HTTPException, match='权限已变化'):
            async with conn.transaction():
                await source_read_lock(conn, who)
        who.id = 'different-owner'; who.role = user['role']
        with pytest.raises(HTTPException, match='授权已变化'):
            async with conn.transaction():
                await source_read_lock(conn, who)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as anonymous:
        assert (await anonymous.get('/api/legacy-financial/authorizations')).status_code == 401
