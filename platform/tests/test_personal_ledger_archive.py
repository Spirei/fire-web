import json
from datetime import UTC, datetime
from decimal import Decimal
from hashlib import sha256
from uuid import uuid4

import httpx
import psycopg
from alcor_api.cli import create_user
from alcor_api.db import Database
from alcor_api.main import create_app
from alcor_api.migrate import migrate
from alcor_api.personal_data_transfer import digest
from alcor_api.personal_ledger_archive import EXTERNAL_REFERENCES, TABLES
from psycopg import sql
from pydantic import SecretStr
from test_cash_ledger import command as cash_command
from test_cash_ledger import submit as cash_submit
from test_trade_amendments import case, complete
from test_trade_amendments import command as amend_command
from test_trading import command as trade_command
from test_trading import setup
from test_trading import submit as trade_submit


async def restore_test_snapshot(db, archive, owner):
    """Load historical rows into a disposable test database, keeping SQL foreign keys enabled."""
    async with db.connection() as conn, conn.transaction():
        target = await (await conn.execute("SELECT current_database() AS name")).fetchone()
        assert db.settings.environment == "test" and target["name"].startswith("alcor_test_")
        assert archive["manifest"]["schemaSha256"] == digest(db.expected_migrations)
        assert archive["manifest"]["ownerId"] == owner
        tables = archive["tables"]
        assert set(tables) == set(TABLES)
        for table, rows in tables.items():
            assert all(row["owner_id"] == owner for row in rows)
            assert len(rows) == archive["manifest"]["counts"][table]
        populated = [table for table in TABLES if tables[table]]
        foreign_keys = await (await conn.execute("""
            SELECT conrelid::regclass::text AS relation, conname
            FROM pg_constraint WHERE contype='f' AND NOT condeferrable
                AND conrelid::regclass::text=ANY(%s)
            """, (populated,))).fetchall()
        for item in foreign_keys:
            await conn.execute(sql.SQL("ALTER TABLE {} ALTER CONSTRAINT {} DEFERRABLE").format(
                sql.Identifier(item["relation"]), sql.Identifier(item["conname"])))
        await conn.execute("SET CONSTRAINTS ALL DEFERRED")
        # Live booking triggers require the revision that preceded each original action.
        # A historical snapshot includes every revision's facts and the final projection.
        for table in populated:
            await conn.execute(sql.SQL("ALTER TABLE {} DISABLE TRIGGER USER").format(sql.Identifier(table)))
        for table in populated:
            query = sql.SQL("INSERT INTO {} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::{}, %s::jsonb)").format(
                sql.Identifier(table), sql.Identifier(table))
            # jsonb values in an archive can also contain exact numbers; retain the raw PostgreSQL text.
            await conn.execute(query, (tables[table].raw,))
        await conn.execute("SET CONSTRAINTS ALL IMMEDIATE")
        for table in populated:
            await conn.execute(sql.SQL("ALTER TABLE {} ENABLE TRIGGER USER").format(sql.Identifier(table)))
        for item in foreign_keys:
            await conn.execute(sql.SQL("ALTER TABLE {} ALTER CONSTRAINT {} NOT DEFERRABLE").format(
                sql.Identifier(item["relation"]), sql.Identifier(item["conname"])))


class RawRows(list):
    raw: str


def read_archive(content):
    prefix = b'{"tables":'
    assert content.startswith(prefix)
    payload, manifest = content[len(prefix):].rsplit(b',"manifest":', 1)
    archive = {"tables": json.loads(payload, parse_float=Decimal), "manifest": json.loads(manifest[:-2])}
    assert sha256(payload).hexdigest() == archive["manifest"]["tablesSha256"]
    decoder = json.JSONDecoder(parse_float=Decimal)
    source = payload.decode()
    offset = 1
    for table in TABLES:
        name, offset = decoder.raw_decode(source, offset)
        assert name == table and source[offset] == ":"
        rows, end = decoder.raw_decode(source, offset + 1)
        exact = RawRows(rows)
        exact.raw = source[offset + 1:end]
        archive["tables"][table] = exact
        offset = end + 1
    return archive


async def test_personal_ledger_roundtrip_into_second_isolated_database(client, admin, db, settings, pg):
    usd, buy, sell = await case(client)
    change = await amend_command(client, buy["recordId"], buy["tradeId"])
    amended, _ = await complete(client, change)
    position = (await client.get(f'/api/portfolio/records/{buy["recordId"]}')).json()["record"]
    closed, _ = await trade_submit(client, trade_command(
        position, side="sell", quantity="5", price="30", amount="150", fees="0.125",
        occurredAt=datetime.now(UTC).isoformat()))
    hkd, hk_position = await setup(client, name="Hong Kong book", market="HK", code="00700", currency="HKD")
    await cash_submit(client, cash_command(hkd, action="external_deposit", amount="12.123456789123456789",
                                           currency="HKD", occurredAt="2026-09-02T00:00:00Z"))
    other = await create_user(settings, "OtherLedger", "Synthetic9Pass", role="user")
    original_file_id = uuid4()
    raw = b'day,amount\r\n2026-09-02,"12.123456789123456789"\r\n'
    async with db.connection() as conn:
        references = await (await conn.execute("""
            SELECT DISTINCT conrelid::regclass::text AS source, confrelid::regclass::text AS target
            FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text=ANY(%s)
              AND NOT(confrelid::regclass::text=ANY(%s))
        """, (list(TABLES), [*TABLES, "users", *EXTERNAL_REFERENCES]))).fetchall()
        assert not references, references
        await conn.execute("INSERT INTO portfolio_records(owner_id,id,name,code,market) VALUES(%s,'private','Other owner','MSFT','US')", (other,))
        user = await (await conn.execute("SELECT username,password_hash FROM users WHERE id=%s", (admin,))).fetchone()
        await conn.execute("""
            INSERT INTO legacy_order_import_sources(owner_id,id,filename,sha256,raw,rows,principal,origin_instance)
            VALUES(%s,%s,'source.csv',%s,%s,'[]'::jsonb,%s,%s)
        """, (admin, original_file_id, sha256(raw).hexdigest(), raw, admin, settings.instance_id))

    path = "/api/personal-data-transfer/ledger"
    assert (await client.get(path, headers={"X-Alcor-Expected-Account": other})).status_code == 403
    response = await client.get(path, headers={"X-Alcor-Expected-Account": admin})
    assert response.status_code == 200, response.text[:800]
    assert other.encode() not in response.content and user["password_hash"].encode() not in response.content
    archive = read_archive(response.content)
    data = archive["tables"]
    assert {row["id"] for row in data["portfolio_records"]} == {closed["recordId"], hk_position["id"]}
    assert {row["id"] for row in data["trade_ledger"]} == {buy["tradeId"], sell["tradeId"], closed["tradeId"]}
    assert data["trade_amendments"][0]["id"] == amended["amendmentId"]
    assert data["trade_amendments"][0]["trade_id"] == buy["tradeId"]
    assert any(row["amount"] == "12.123456789123456789" for row in data["cash_ledger_entries"])
    trace_path = "/api/personal-data-transfer/records"
    for section in ("positions", "trades", "funds", "corrections", "originals"):
        listing = await client.get(trace_path, params={"section": section})
        assert listing.status_code == 200, listing.text
        assert other not in listing.text
    correction = await client.get(trace_path, params={"type": "amendment", "id": amended["amendmentId"]})
    assert correction.status_code == 200, correction.text
    assert any(link["type"] == "trade" and link["id"] == buy["tradeId"] for link in correction.json()["links"])
    assert any(link["type"] == "cash" for link in correction.json()["links"])
    assert (await client.get(trace_path, params={"type": "position", "id": "private"})).status_code == 404
    latest = (await client.get(trace_path, params={"type": "position", "id": closed["recordId"]})).json()
    assert latest["data"]["qty"] == "0" and "original" not in latest
    previous = (await client.get(trace_path, params={"type": "position", "id": closed["recordId"],
                                                     "revision": latest["versions"][1]["revision"]})).json()
    assert previous["data"]["qty"] == "5"
    original = (await client.get(trace_path, params={"type": "position", "id": closed["recordId"],
                                                     "revision": latest["versions"][-1]["revision"]})).json()
    assert original["version"]["action"] == "create"
    file_response = await client.get("/api/personal-data-transfer/original", params={"type": "orderFile", "id": str(original_file_id)})
    assert file_response.status_code == 200 and file_response.content == raw
    assert file_response.headers["X-Alcor-File-Format"] == "csv"

    database_name = "alcor_test_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as admin_conn:
        admin_conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name)))
        target = settings.model_copy(update={"database_url": SecretStr(pg.get_uri(database=database_name)), "instance_id": uuid4()})
        try:
            await migrate(target, database_name, initialize_empty=True)
            target_db = Database(target)
            await target_db.open()
            try:
                async with target_db.connection() as conn:
                    await conn.execute("INSERT INTO users(id,username,password_hash,role) VALUES(%s,%s,%s,'admin')",
                                       (admin, user["username"], user["password_hash"]))
                await restore_test_snapshot(target_db, archive, admin)
                async with db.connection() as original, target_db.connection() as restored:
                    for table in TABLES:
                        query = sql.SQL("SELECT to_jsonb(t)::text AS row FROM {} t WHERE owner_id=%s ORDER BY 1").format(sql.Identifier(table))
                        assert await (await original.execute(query, (admin,))).fetchall() == await (await restored.execute(query, (admin,))).fetchall(), table
            finally:
                await target_db.close()
            restored_app = create_app(target)
            async with restored_app.router.lifespan_context(restored_app), httpx.AsyncClient(
                transport=httpx.ASGITransport(app=restored_app), base_url="http://testserver", headers={"origin": "http://testserver"},
            ) as restored:
                assert (await restored.post("/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"})).status_code == 200
                for route in (f"/api/cash/accounts/{usd}", f"/api/cash/accounts/{hkd}",
                              f'/api/portfolio/records/{closed["recordId"]}', f'/api/trading/fills?recordId={closed["recordId"]}'):
                    expected, obtained = await client.get(route), await restored.get(route)
                    assert expected.status_code == obtained.status_code == 200
                    assert expected.json() == obtained.json()
        finally:
            admin_conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database_name)))


async def test_personal_ledger_spools_large_original_and_keeps_all_rows(client, admin, db, settings):
    raw = b"date,amount\n" + b"2026-09-02,12.123456789123456789\n" * 60000
    identifier = uuid4()
    async with db.connection() as conn:
        await conn.execute("""
            INSERT INTO legacy_order_import_sources(owner_id,id,filename,sha256,raw,rows,principal,origin_instance)
            VALUES(%s,%s,'large.csv',%s,%s,'[]'::jsonb,%s,%s)
        """, (admin, identifier, sha256(raw).hexdigest(), raw, admin, settings.instance_id))
    response = await client.get("/api/personal-data-transfer/ledger")
    assert response.status_code == 200
    assert len(response.content) == int(response.headers["Content-Length"]) > 2 * 1024 * 1024
    exported = read_archive(response.content)["tables"]["legacy_order_import_sources"]
    assert len(exported) == 1 and exported[0]["id"] == str(identifier)
    assert sha256(bytes.fromhex(exported[0]["raw"][2:])).hexdigest() == sha256(raw).hexdigest()
