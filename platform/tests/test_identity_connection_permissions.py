from uuid import uuid4

import pytest
from psycopg import sql
from test_connections import P, request_data, values


@pytest.mark.parametrize("table,permission", [("identity_security", "UPDATE"), ("sessions", "UPDATE")])
async def test_candidate_missing_identity_permissions_is_not_applied(
    settings, client, admin, db, table, permission
):
    role = "identity_limited_" + uuid4().hex
    async with db.connection() as conn:
        await conn.execute(sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(role)))
        await conn.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(role)))
        await conn.execute(
            sql.SQL("GRANT ALL ON ALL TABLES IN SCHEMA public TO {}").format(sql.Identifier(role))
        )
        await conn.execute(
            sql.SQL("GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO {}").format(sql.Identifier(role))
        )
        await conn.execute(
            sql.SQL("REVOKE {} ON {} FROM {}").format(
                sql.SQL(permission), sql.Identifier(table), sql.Identifier(role)
            )
        )
    try:
        result = await client.put(P + "postgresql", json=await request_data(client, settings, username=role))
        assert result.status_code == 200 and result.json()["status"] == "failed", result.text
        assert "权限" in result.json()["message"]
        assert (await values(client))["revision"] is None
        assert (await client.get("/api/session")).status_code == 200
    finally:
        async with db.connection() as conn:
            await conn.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)))
            await conn.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))
