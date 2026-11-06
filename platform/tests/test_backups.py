import base64
import hashlib
import io
import json
import re
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import psycopg
import pytest
import pytest_asyncio
from alcor_api import backups
from alcor_api.backups import BackupFailure, target_connection
from alcor_api.cli import create_user
from alcor_api.config import RestoreTarget
from alcor_api.connections import Vault, current_config
from alcor_api.db import Database
from alcor_api.main import create_app
from alcor_api.migrate import migrate
from alcor_api.security import COOKIE, csrf_token, digest
from alcor_api.worker import claim, finish
from pgserver.postgres_server import POSTGRES_BIN_PATH
from PIL import Image
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from pydantic import SecretStr

P = "/api"


async def test_retention_requires_matching_schema_registration(db):
    async with db.connection() as conn, conn.transaction(force_rollback=True):
        assert await backups.retention_installed(conn)
        await conn.execute('DROP TABLE backup_retention_results')
        with pytest.raises(BackupFailure, match='结构不完整'):
            await backups.retention_installed(conn)


@pytest_asyncio.fixture
async def configured(settings, pg, tmp_path):
    with psycopg.connect(settings.database_url.get_secret_value()) as conn:
        user = conn.execute("SELECT current_user").fetchone()[0]
        data_dir = Path(conn.execute("SHOW data_directory").fetchone()[0])
    info = conninfo_to_dict(settings.database_url.get_secret_value())
    info["user"] = user
    settings.database_url = SecretStr(make_conninfo(**info))
    settings.backup_dir = tmp_path / "backups"
    settings.backup_secret_dir = tmp_path / "backup-key"
    settings.file_root = tmp_path / "files"
    settings.pg_tools_dir = POSTGRES_BIN_PATH
    settings.file_root.mkdir(mode=0o700)
    body = b"Owned immutable isolated file\x00sample"
    path = settings.file_root / hashlib.sha256(body).hexdigest()
    path.write_bytes(body)
    path.chmod(0o600)
    name = "alcor_restore_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    info["dbname"] = name
    target = RestoreTarget(
        id="isolated-qa",
        name="Isolated QA",
        database_url=make_conninfo(**info),
        instance_id=uuid4(),
        data_directory=data_dir,
        recovery_directory=tmp_path / "restored",
    )
    settings.restore_targets = [target]
    conn = await target_connection(target, enroll=True)
    await conn.close()
    yield settings
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        assert name.startswith("alcor_restore_")
        conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest_asyncio.fixture
async def backup_app(configured):
    app = create_app(configured)
    async with app.router.lifespan_context(app):
        yield app


@pytest_asyncio.fixture
async def bc(backup_app, configured):
    await create_user(configured, "BackupQA", "Synthetic9Pass")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=backup_app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as client:
        response = await client.post(
            P + "/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert response.status_code == 200
        client.headers["x-csrf-token"] = response.json()["csrf"]
        yield client


async def submit(client, kind="backup.create", **payload):
    data = {"kind": kind, "request_id": str(uuid4())} | payload
    response = await client.post(P + "/tasks", json=data)
    assert response.status_code == 202, response.text
    return response.json(), data


async def execute(app, settings, expected):
    task = await claim(app.state.db, uuid4())
    assert task and task["id"] == expected
    result = await backups.run_job(settings, app.state.db, task)
    assert await finish(app.state.db, task, result)
    return result


async def create_capsule(bc, backup_app, configured):
    response, _ = await submit(bc)
    result = await execute(
        backup_app,
        configured,
        UUID(response["id"]),
    )
    return response["id"], result


async def test_backup_is_encrypted_verified_and_idempotent(bc, backup_app, configured):
    job, data = await submit(bc)
    from uuid import UUID

    result = await execute(backup_app, configured, UUID(job["id"]))
    assert result["message"] == "备份已完成"
    response = await bc.post(P + "/tasks", json=data)
    assert response.status_code == 202 and response.json()["id"] == job["id"]
    row = await backups.row_for(backup_app.state.db, UUID(job["id"]))
    raw = (configured.backup_dir / (job["id"] + ".enc")).read_bytes()
    assert b"BackupQA" not in raw and b"Owned immutable" not in raw
    assert (
        raw[:5] != b"PGDMP" and (configured.backup_dir / (job["id"] + ".enc")).stat().st_mode & 0o777 == 0o600
    )
    manifest, entries = backups.unpack(configured, row)
    assert manifest["instance_id"] == str(configured.instance_id)
    assert len([k for k in entries if k.startswith("files/")]) == 1
    assert entries["database.dump"].startswith(b"PGDMP")
    downloaded = await bc.get(P + "/backups/" + job["id"] + "/download")
    assert downloaded.status_code == 200 and downloaded.content == raw
    verify, _ = await submit(bc, "backup.verify", backup_id=job["id"])
    verified = await execute(backup_app, configured, UUID(verify["id"]))
    assert verified["message"] == "备份校验通过"


async def test_restore_proves_all_rows_media_and_keys_and_quarantines_live_access(bc, backup_app, configured):
    from uuid import UUID
    from test_account_preferences import appearance

    preferences = await bc.patch(
        P + "/account/preferences",
        json={"revision": None, "appearance": appearance(), "avatar_status": "focus"},
    )
    assert preferences.status_code == 200, preferences.text

    image = Image.new("RGB", (20, 20), "blue")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    avatar = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    saved = await bc.patch(
        P + "/profile", json={"display_name": "Restored owner", "avatar_data": avatar, "revision": None}
    )
    assert saved.status_code == 200, saved.text
    config, _ = current_config(configured, "postgresql")
    response = await bc.put(
        P + "/connections/postgresql",
        json={
            "request_id": str(uuid4()),
            "revision": None,
            "config": config.model_dump(),
            "password_mode": "replace",
            "password": "SyntheticBackupConn7",
        },
    )
    assert response.status_code == 200 and response.json()["status"] == "saved", response.text
    from test_client_auth import grant, register

    await register(bc)
    live_token = await grant(bc)
    # A restored snapshot must not reactivate deployment credentials or queued host updates.
    async with backup_app.state.db.connection() as conn:
        owner=await (await conn.execute('SELECT id FROM users ORDER BY created_at LIMIT 1')).fetchone()
        await conn.execute("INSERT INTO deployment_configuration(singleton,repository,token_ciphertext) VALUES(true,'synthetic/alcor-api','synthetic-ciphertext-only')")
        await conn.execute("INSERT INTO deployment_requests(id,owner_id,request_id,image,version,revision,schema_hash,status) VALUES(%s,%s,%s,'synthetic-image','0.0.1','synthetic-sha','synthetic-schema','queued')",(uuid4(),owner['id'],uuid4()))
        await conn.execute('INSERT INTO deployment_runner(singleton) VALUES(true)')
        from alcor_api.native_app_auth import issue_grant
        native_owner = await (await conn.execute('SELECT * FROM users WHERE id=%s',(owner['id'],))).fetchone()
        await issue_grant(conn,native_owner,'portfolio.read','Synthetic restored device')
        for delivery_state in ('queued','sending'):
            await conn.execute("INSERT INTO identity_mail_outbox(id,user_id,challenge_id,kind,status,ciphertext,expires_at) VALUES(%s,%s,'synthetic-restored-challenge','password-reset',%s,'synthetic-ciphertext-only',clock_timestamp()+interval '5 minutes')",(uuid4(),owner['id'],delivery_state))
        await conn.execute("INSERT INTO cash_ledger_entries(id,owner_id,account_kind,currency,request_id,kind,amount,affects_owner,occurred_at,note) VALUES(%s,%s,'real','USD',%s,'opening',125.50,true,clock_timestamp(),'Synthetic restore checkpoint')",(uuid4(),owner['id'],uuid4()))

    configured.asset_root=tmp_assets=configured.file_root.parent/'assets'
    tmp_assets.mkdir(mode=0o700)
    asset=tmp_assets/'logo.png';asset.write_bytes(b'Synthetic stored asset');asset.chmod(0o600)
    backup_id, _ = await create_capsule(bc, backup_app, configured)
    preview = await bc.get(
        P + "/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    job, _ = await submit(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    result = await execute(backup_app, configured, UUID(job["id"]))
    assert result["sessions_revoked"] and result["connections_quarantined"]
    target = configured.restore_targets[0]
    async with await psycopg.AsyncConnection.connect(
        target.database_url.get_secret_value(),
        row_factory=dict_row,
    ) as conn:
        profile = await (await conn.execute("SELECT display_name,avatar FROM user_profiles")).fetchone()
        assert profile["display_name"] == "Restored owner" and bytes(profile["avatar"])[:2] == b"\xff\xd8"
        marker = await (await conn.execute("SELECT * FROM alcor_instance")).fetchone()
        assert marker["instance_id"] == target.instance_id and marker["environment"] == "test"
        assert (await (await conn.execute("SELECT count(*) AS n FROM sessions")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT count(*) AS n FROM connection_settings")).fetchone())[
            "n"
        ] == 0
        assert (await (await conn.execute('SELECT count(*) AS n FROM deployment_configuration')).fetchone())['n']==0
        assert (await (await conn.execute('SELECT count(*) AS n FROM deployment_runner')).fetchone())['n']==0
        assert (await (await conn.execute('SELECT status FROM deployment_requests')).fetchone())['status']=='unknown'
        assert not await (await conn.execute('SELECT 1 FROM identity_app_grants WHERE revoked_at IS NULL')).fetchone()
        mail = await (await conn.execute('SELECT status,ciphertext FROM identity_mail_outbox ORDER BY status')).fetchall()
        assert mail == [{'status':'cancelled','ciphertext':None},{'status':'unknown','ciphertext':None}]
        assert (await (await conn.execute("SELECT payload FROM restore_quarantine WHERE category='external_delivery_disabled'")).fetchone())['payload'] == {'disabled':True}
        cash = await (await conn.execute('SELECT amount,note FROM cash_ledger_entries')).fetchone()
        assert str(cash['amount']) == '125.50' and cash['note'] == 'Synthetic restore checkpoint'

        archived = await (
            await conn.execute("SELECT payload FROM restore_quarantine WHERE category='connection_settings'")
        ).fetchone()
        pg = next(x for x in archived["payload"] if x["kind"] == "postgresql")
    recovered_key = Vault(target.recovery_directory / "connection-secrets")
    assert (
        recovered_key.decrypt(pg["password_ciphertext"], "postgresql", configured.instance_id)
        == "SyntheticBackupConn7"
    )
    assert not list((target.recovery_directory / "connection-secrets").glob("bootstrap-*.enc"))
    assert (target.recovery_directory/'assets'/'logo.png').read_bytes()==b'Synthetic stored asset'
    original_file = next(configured.file_root.iterdir())
    assert (
        target.recovery_directory / "files" / original_file.name
    ).read_bytes() == original_file.read_bytes()
    assert (await bc.get(P + "/session")).status_code == 200
    restored_settings = configured.model_copy(
        update={
            "database_url": target.database_url,
            "instance_id": target.instance_id,
            "connection_secret_dir": target.recovery_directory / "connection-secrets",
            "file_root": target.recovery_directory / "files",
            "restore_targets": [],
        }
    )
    target_app = create_app(restored_settings)
    async with (
        target_app.router.lifespan_context(target_app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=target_app), base_url="http://testserver", cookies=bc.cookies
        ) as restored_client,
    ):
        assert (await restored_client.get(P + "/session")).status_code == 401
        assert (
            await restored_client.get(
                P + "/connect/profile", headers={"Authorization": "Bearer " + live_token["access_token"]}
            )
        ).status_code == 401
        assert (await target_app.state.connections.read("postgresql"))["config"] is None
        login = await restored_client.post(
            P + "/session/login",
            json={"login": "BackupQA", "password": "Synthetic9Pass"},
            headers={"origin": "http://testserver"},
        )
        assert login.status_code == 200, login.text
        assert (await restored_client.get(P + "/account/preferences")).json() == preferences.json()
        assert (await restored_client.get(P + "/account")).json()["uid"] == "1"
        new_user = await create_user(restored_settings, "AfterRestore", "Synthetic9Pass", role="user")
        async with target_app.state.db.connection() as conn:
            assert (await (await conn.execute("SELECT uid FROM users WHERE id=%s", (new_user,))).fetchone())["uid"] == "2"
    assert (
        await bc.get(
            P + "/connect/profile", headers={"Authorization": "Bearer " + live_token["access_token"]}
        )
    ).status_code == 200
    assert (
        await bc.get(P + "/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"})
    ).status_code == 422


async def test_tampered_or_wrong_key_capsule_never_restores(bc, backup_app, configured):
    from uuid import UUID

    backup_id, _ = await create_capsule(bc, backup_app, configured)
    row = await backups.row_for(backup_app.state.db, UUID(backup_id))
    path = configured.backup_dir / (backup_id + ".enc")
    original = path.read_bytes()
    path.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    with pytest.raises(BackupFailure, match="校验"):
        backups.unpack(configured, row)
    path.write_bytes(original)
    configured.backup_secret_dir = configured.backup_secret_dir.parent / "different-key"
    with pytest.raises(BackupFailure, match="密钥"):
        backups.unpack(configured, row)


async def test_nonempty_wrong_identity_and_active_source_targets_are_rejected(bc, backup_app, configured):
    backup_id, _ = await create_capsule(bc, backup_app, configured)
    target = configured.restore_targets[0]
    wrong = target.model_copy(update={"data_directory": Path("/not-the-owned-pg")})
    with pytest.raises(BackupFailure):
        await target_connection(wrong)
    with psycopg.connect(target.database_url.get_secret_value(), autocommit=True) as conn:
        conn.execute("CREATE TABLE unexpected(value text)")
    assert (
        await bc.get(P + "/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"})
    ).status_code == 422
    configured.restore_targets = [target.model_copy(update={"instance_id": configured.instance_id})]
    with pytest.raises(BackupFailure):
        backups.target_for(configured, "isolated-qa")


async def test_restore_ticket_is_owned_bound_and_expires(bc, backup_app, configured):
    from cryptography.fernet import Fernet

    backup_id, _ = await create_capsule(bc, backup_app, configured)
    preview = (
        await bc.get(P + "/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"})
    ).json()
    target = configured.restore_targets[0]
    with pytest.raises(BackupFailure):
        backups.ticket_data(configured, preview["restore_ticket"], "someone-else", backup_id, target)
    data = Fernet(backups.backup_key(configured)).decrypt(preview["restore_ticket"].encode())
    expired = Fernet(backups.backup_key(configured)).encrypt_at_time(data, 1).decode()
    result = await bc.post(
        P + "/tasks",
        json={
            "kind": "backup.restore",
            "request_id": str(uuid4()),
            "backup_id": backup_id,
            "target_id": "isolated-qa",
            "restore_ticket": expired,
        },
    )
    assert result.status_code == 422


async def test_revocation_and_lease_loss_block_backup_publication(bc, backup_app, configured):
    from uuid import UUID

    job, _ = await submit(bc)
    task = await claim(backup_app.state.db, uuid4())
    async with backup_app.state.db.connection() as conn:
        await conn.execute("UPDATE tasks SET lease_version=lease_version+1 WHERE id=%s", (UUID(job["id"]),))
    with pytest.raises(BackupFailure):
        await backups.run_job(configured, backup_app.state.db, task)
    assert not list(configured.backup_dir.glob("*.enc"))
    second, _ = await submit(bc)
    second_task = await claim(backup_app.state.db, uuid4())
    assert str(second_task["id"]) == second["id"]
    async with backup_app.state.db.connection() as conn:
        await conn.execute("UPDATE users SET active=false WHERE id=%s", (second_task["owner_id"],))
    with pytest.raises(BackupFailure, match="授权"):
        await backups.run_job(configured, backup_app.state.db, second_task)
    assert not list(configured.backup_dir.glob("*.enc"))


async def test_failed_new_backup_preserves_last_verified_archive(bc, backup_app, configured, monkeypatch):
    backup_id, _ = await create_capsule(bc, backup_app, configured)
    path = configured.backup_dir / (backup_id + ".enc")
    before = path.read_bytes()
    _job, _ = await submit(bc)
    task = await claim(backup_app.state.db, uuid4())

    async def fail(*args, **kwargs):
        raise BackupFailure("隔离测试工具失败")

    monkeypatch.setattr(backups, "command", fail)
    with pytest.raises(BackupFailure):
        await backups.run_job(configured, backup_app.state.db, task)
    assert path.read_bytes() == before and len(list(configured.backup_dir.glob("*.enc"))) == 1


async def test_backup_interfaces_reject_non_admin_and_recent_auth_expiry(bc, backup_app, configured):
    await create_user(configured, "BackupPeer", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=backup_app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        session = (
            await peer.post(P + "/session/login", json={"login": "BackupPeer", "password": "Synthetic9Pass"})
        ).json()
        peer.headers["x-csrf-token"] = session["csrf"]
        assert (await peer.get(P + "/backups")).status_code == 403
        assert (
            await peer.post(P + "/tasks", json={"kind": "backup.create", "request_id": str(uuid4())})
        ).status_code == 403
    async with backup_app.state.db.connection() as conn:
        await conn.execute(
            "UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes' WHERE token_hash=%s",
            (digest(bc.cookies["alcor_session"]),),
        )
    response = await bc.post(P + "/tasks", json={"kind": "backup.create", "request_id": str(uuid4())})
    assert response.status_code == 403


async def test_unsafe_files_and_private_directory_permissions_are_rejected(bc, backup_app, configured):
    unsafe = configured.file_root / ("0" * 64)
    unsafe.symlink_to("/etc/hosts")
    with pytest.raises((BackupFailure, OSError)):
        backups.media_entries(configured)
    unsafe.unlink()
    configured.backup_dir.mkdir(mode=0o755)
    with pytest.raises(BackupFailure):
        backups.private_dir(configured.backup_dir)


async def test_known_older_schema_restores_then_upgrades_only_the_isolated_target(
    configured, pg, tmp_path
):
    baseline = tmp_path / "schema-six"
    baseline.mkdir()
    current = configured.migration_dir
    for path in sorted(current.glob("000[1-6]_*.sql")):
        (baseline / path.name).write_bytes(path.read_bytes())
    assert len(list(baseline.glob("*.sql"))) == 6

    # Build a real historical source rather than reverse-engineering an older schema
    # by dropping some columns from today's database. New migrations must remain strict.
    name = "alcor_test_backup_old_" + uuid4().hex
    source_info = conninfo_to_dict(configured.database_url.get_secret_value())
    assert source_info["dbname"].startswith("alcor_test_")
    assert name != conninfo_to_dict(configured.restore_targets[0].database_url.get_secret_value())["dbname"]
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        assert Path(conn.execute("SHOW data_directory").fetchone()[0]).resolve() == configured.restore_targets[0].data_directory.resolve()
        assert conn.execute("SHOW listen_addresses").fetchone()[0] == ""
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    source_info["dbname"] = name
    historical = configured.model_copy(update={
        "database_url": SecretStr(make_conninfo(**source_info)),
        "instance_id": uuid4(),
        "migration_dir": baseline,
        "connection_secret_dir": tmp_path / "historical-connection-secrets",
    })
    try:
        await migrate(historical, name, initialize_empty=True)
        owner = "historical-backup-owner"
        from alcor_api.passwords import hash_password
        with psycopg.connect(historical.database_url.get_secret_value()) as seed:
            seed.execute("INSERT INTO users(id,username,password_hash,role) VALUES(%s,'HistoricalBackupQA',%s,'admin')", (owner,hash_password("Synthetic9Pass")))
            seed.execute("UPDATE registration_state SET bootstrap_completed=true,first_admin_user_id=%s,claimed_at=clock_timestamp() WHERE singleton",(owner,))
        token = "synthetic-historical-backup-session"
        with psycopg.connect(historical.database_url.get_secret_value(), row_factory=dict_row) as conn:
            # A historical session avoids calling newer login-factor APIs against schema6.
            conn.execute(
                "INSERT INTO sessions(token_hash,user_id,session_version,expires_at) VALUES(%s,%s,1,clock_timestamp()+interval '1 day')",
                (digest(token), owner),
            )
            before = conn.execute("SELECT * FROM users WHERE id=%s", (owner,)).fetchone()
            assert not {"revision", "uid", "deleted_at"} & before.keys()
            history = conn.execute("SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name").fetchall()
            assert len(history) == 6
        historical_app = create_app(historical)
        async with historical_app.router.lifespan_context(historical_app), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=historical_app, raise_app_exceptions=False),
            base_url="http://testserver", cookies={COOKIE: token},
            headers={"origin": "http://testserver", "x-csrf-token": csrf_token(token)},
        ) as client:
            backup_id, _ = await create_capsule(client, historical_app, historical)
            # The source pool still checks the six frozen hashes. Only restore uses
            # the current directory to upgrade its separately enrolled empty target.
            historical.migration_dir = current
            preview = await client.get(
                P + "/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
            )
            assert preview.status_code == 200, preview.text
            job, _ = await submit(
                client, "backup.restore", backup_id=backup_id, target_id="isolated-qa",
                restore_ticket=preview.json()["restore_ticket"],
            )
            result = await execute(historical_app, historical, UUID(job["id"]))
            assert result["tables_verified"] > 0
            target = historical.restore_targets[0]
            recovered = Database(historical.model_copy(update={
                "database_url": target.database_url, "instance_id": target.instance_id,
            }))
            await recovered.open()
            try:
                async with recovered.connection() as conn:
                    restored = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
                    assert {column: restored[column] for column in before} == before
                    assert restored["revision"] and restored["uid"] == "1" and restored["deleted_at"] is None
                    applied = await (await conn.execute("SELECT name,sha256 FROM schema_migrations ORDER BY name")).fetchall()
                    assert {row["name"]: row["sha256"] for row in applied} == recovered.expected_migrations
                    assert (await (await conn.execute("SELECT count(*) AS n FROM sessions")).fetchone())["n"] == 0
            finally:
                await recovered.close()
            async with historical_app.state.db.connection() as conn:
                assert await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone() == before
                assert await (await conn.execute("SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name")).fetchall() == history
                assert (await (await conn.execute("SELECT count(*) AS n FROM sessions WHERE token_hash=%s", (digest(token),))).fetchone())["n"] == 1
                assert (await (await conn.execute("SELECT instance_id FROM alcor_instance")).fetchone())["instance_id"] == historical.instance_id
    finally:
        with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
            assert name.startswith("alcor_test_backup_old_")
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


async def test_restore_rebinds_native_factor_secrets_without_disabling_totp(bc, backup_app, configured):
    vault = Vault(configured.connection_secret_dir)
    async with backup_app.state.db.connection() as conn:
        user = (await (await conn.execute("SELECT id FROM users WHERE username='BackupQA'")).fetchone())["id"]
        totp = vault.encrypt("JBSWY3DPEHPK3PXP", "totp:" + user, configured.instance_id)
        recovery = vault.encrypt("12" * 32, "backup-key:" + user, configured.instance_id)
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext,backup_key_ciphertext,totp_last_step) VALUES(%s,true,%s,%s,123)",
            (user, totp, recovery),
        )
        await conn.execute(
            "UPDATE identity_passkey_config SET enabled=true,origin='https://source.example.invalid',rp_id='source.example.invalid'"
        )
        await conn.execute(
            "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES('qa','password-login',%s,'qa','{}',clock_timestamp()+interval '5 minutes')",
            (user,),
        )
    backup_id, _ = await create_capsule(bc, backup_app, configured)
    preview = await bc.get(
        P + "/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    job, _ = await submit(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    await execute(backup_app, configured, UUID(job["id"]))
    target = configured.restore_targets[0]
    restored_vault = Vault(target.recovery_directory / "connection-secrets")
    async with await psycopg.AsyncConnection.connect(
        target.database_url.get_secret_value(), row_factory=dict_row
    ) as conn:
        factor = await (
            await conn.execute("SELECT * FROM identity_security WHERE user_id=%s", (user,))
        ).fetchone()
        assert factor["totp_enabled"] and factor["totp_last_step"] == 123
        assert (
            restored_vault.decrypt(factor["totp_secret_ciphertext"], "totp:" + user, target.instance_id)
            == "JBSWY3DPEHPK3PXP"
        )
        assert (
            restored_vault.decrypt(factor["backup_key_ciphertext"], "backup-key:" + user, target.instance_id)
            == "12" * 32
        )
        assert (await (await conn.execute("SELECT count(*) AS n FROM identity_challenges")).fetchone())[
            "n"
        ] == 0
        assert not (await (await conn.execute("SELECT enabled FROM identity_passkey_config")).fetchone())[
            "enabled"
        ]
    async with backup_app.state.db.connection() as conn:
        factor = await (
            await conn.execute("SELECT * FROM identity_security WHERE user_id=%s", (user,))
        ).fetchone()
        assert factor["totp_secret_ciphertext"] == totp and factor["totp_enabled"]


async def test_card_preferences_encrypted_backup_restores_labels_tombstones_and_receipts(bc, backup_app, configured):
    from alcor_api.card_preferences import CardPreferences, restore_json
    from alcor_api.security import Identity

    source = backup_app.state.db
    async with source.connection() as conn:
        row = await (await conn.execute(
            'SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=%s',
            (digest(bc.cookies[COOKIE]),),
        )).fetchone()
    who = Identity(**row, token_hash=digest(bc.cookies[COOKIE]), csrf=bc.headers['x-csrf-token'])
    preferences = CardPreferences(source)
    tags_id, held_id, cleared_id = uuid4(), uuid4(), uuid4()
    tags = await preferences.mutate(who, 'tags', 'synthetic-card', ['PrivateTag', '😀' * 5 + 'a\ud83d', 'nul\x00tag'], tags_id)
    await preferences.mutate(who, 'holdings', 'synthetic-card', True, held_id)
    cleared = await preferences.mutate(who, 'holdings', 'synthetic-card', False, cleared_id)
    backup_id, _ = await create_capsule(bc, backup_app, configured)
    raw = (configured.backup_dir / (backup_id + '.enc')).read_bytes()
    assert b'PrivateTag' not in raw and b'synthetic-card' not in raw
    capsule = await backups.row_for(source, UUID(backup_id))
    manifest, _ = backups.unpack(configured, capsule)
    assert manifest['tables']['card_preference_tags']['rows'] == 1
    assert manifest['tables']['card_preference_holdings']['rows'] == 1
    assert manifest['tables']['card_preference_operations']['rows'] == 3
    preview = await bc.get(P + '/backups/' + backup_id + '/restore-preview', params={'target_id': 'isolated-qa'})
    assert preview.status_code == 200, preview.text
    job, _ = await submit(bc, 'backup.restore', backup_id=backup_id, target_id='isolated-qa', restore_ticket=preview.json()['restore_ticket'])
    result = await execute(backup_app, configured, UUID(job['id']))
    assert result['sessions_revoked'] and result['connections_quarantined']
    target = configured.restore_targets[0]
    async with await psycopg.AsyncConnection.connect(target.database_url.get_secret_value(), row_factory=dict_row) as conn:
        assert (await (await conn.execute('SELECT instance_id FROM alcor_instance')).fetchone())['instance_id'] == target.instance_id
        stored_tags = (await (await conn.execute('SELECT tags FROM card_preference_tags WHERE owner_id=%s', (who.id,))).fetchone())['tags']
        assert [restore_json(value) for value in stored_tags] == ['PrivateTag', '😀' * 5 + 'a�', 'nul\x00tag']
        assert (await (await conn.execute('SELECT held FROM card_preference_holdings WHERE owner_id=%s', (who.id,))).fetchone())['held'] is False
        assert (await (await conn.execute('SELECT revision FROM card_preference_collections WHERE owner_id=%s', (who.id,))).fetchone())['revision'] == 3
        receipts = await (await conn.execute('SELECT request_id,result FROM card_preference_operations WHERE owner_id=%s', (who.id,))).fetchall()
        saved = {row['request_id']: restore_json(row['result']) for row in receipts}
        assert saved[tags_id] == tags and saved[cleared_id] == cleared and len(saved) == 3
        assert (await (await conn.execute('SELECT count(*) AS n FROM sessions')).fetchone())['n'] == 0
    # Recovery operates on a separate enrolled target and leaves original data/authorization intact.
    assert await preferences.receipt(who, tags_id) == tags
    assert (await preferences.read(who))['holdings'] == []


async def test_card_catalog_backup_restores_frozen_manifest_custom_tombstones_and_shared_bytes(bc, backup_app, configured):
    from alcor_api.card_catalog_contract import manifest_value
    from alcor_api.card_preferences import restore_json
    from alcor_api.security import Identity

    db = backup_app.state.db
    async with db.connection() as conn:
        row = await (await conn.execute('SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=%s', (digest(bc.cookies[COOKIE]),))).fetchone()
    who = Identity(**row, token_hash=digest(bc.cookies[COOKIE]), csrf=bc.headers['x-csrf-token'])
    source = '{"regions":[{"banks":[{"name":"Synthetic Bank","cards":[{"name":"Catalog Card","file":"synthetic/catalog.png"}]}]}],"source":"Synthetic backup catalog"}'
    service = backup_app.state.card_catalog
    preview = manifest_value(source, 'Synthetic catalog')
    source_receipt = await service.import_source(who, source, 'Synthetic catalog', uuid4(), 0, preview['sha256'])
    image_bytes = io.BytesIO()
    Image.new('RGB', (2, 2), '#447799').save(image_bytes, 'PNG')
    uploaded = await bc.post('/api/admin/shared-assets/upload', data={'kind': 'asset', 'folder': 'card', 'name': 'Synthetic card', 'requestId': str(uuid4()), 'expectedRevision': '0'}, files={'file': ('synthetic.png', image_bytes.getvalue(), 'image/png')})
    assert uploaded.status_code == 200, uploaded.text
    image = uploaded.json()['legacyUrl']
    card = await service.create(who, {'name': 'Backup Custom', 'bank': 'Backup Bank', 'image': image}, uuid4())
    deleted = await service.delete(who, card['card']['id'], uuid4())
    backup_id, _ = await create_capsule(bc, backup_app, configured)
    raw = (configured.backup_dir / (backup_id + '.enc')).read_bytes()
    assert b'Backup Custom' not in raw and b'Synthetic backup catalog' not in raw
    preview_response = await bc.get(P + '/backups/' + backup_id + '/restore-preview', params={'target_id': 'isolated-qa'})
    assert preview_response.status_code == 200, preview_response.text
    task, _ = await submit(bc, 'backup.restore', backup_id=backup_id, target_id='isolated-qa', restore_ticket=preview_response.json()['restore_ticket'])
    restored = await execute(backup_app, configured, UUID(task['id']))
    assert restored['sessions_revoked']
    target = configured.restore_targets[0]
    async with await psycopg.AsyncConnection.connect(target.database_url.get_secret_value(), row_factory=dict_row) as conn:
        saved_source = await (await conn.execute('SELECT sha256,manifest,original_text FROM card_catalog_sources')).fetchone()
        assert saved_source['original_text'] == source
        assert hashlib.sha256(saved_source['original_text'].encode()).hexdigest() == saved_source['sha256']
        assert saved_source['sha256'] == source_receipt['sha256'] and restore_json(saved_source['manifest']) == json.loads(source)
        saved = await (await conn.execute('SELECT metadata,deleted_at,image_version FROM card_custom_records WHERE owner_id=%s', (who.id,))).fetchone()
        assert restore_json(saved['metadata'])['name'] == 'Backup Custom' and saved['deleted_at'] is not None
        assert str(saved['image_version']) == uploaded.json()['version']
        operations = await (await conn.execute('SELECT result FROM card_catalog_operations WHERE owner_id=%s', (who.id,))).fetchall()
        assert {restore_json(row['result'])['requestId'] for row in operations} == {source_receipt['requestId'], card['requestId'], deleted['requestId']}
        index = await (await conn.execute('SELECT deleted_at FROM card_catalog_public_index WHERE image_path=%s', (image,))).fetchone()
        assert index['deleted_at'] is not None
        material = await (await conn.execute('SELECT served_sha256 FROM system_asset_versions WHERE id=%s', (saved['image_version'],))).fetchone()
    # The registered shared original/served bytes are recovered, rather than inferred from metadata.
    directory = target.recovery_directory
    candidates = list(directory.rglob(material['served_sha256']))
    assert candidates and any(path.read_bytes() == image_bytes.getvalue() for path in candidates)
    assert (await service.snapshot(who))['source']['sha256'] == source_receipt['sha256']


async def test_manual_card_wallet_backup_restores_exact_history_and_owner_secrets_without_broker_merging(bc,backup_app,configured):
    from alcor_api.security import Identity
    db=backup_app.state.db
    async with db.connection() as conn:
        row=await(await conn.execute('SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=%s',(digest(bc.cookies[COOKIE]),))).fetchone()
    who=Identity(**row,token_hash=digest(bc.cookies[COOKIE]),csrf=bc.headers['x-csrf-token'])
    wallet=backup_app.state.card_wallet
    card='synthetic/backup-wallet.png'
    details=await wallet.save_details(who,card,{'number':'4111111111111111','expiry':'12/2099','cvv':'9876'},uuid4(),0)
    data={'requestId':str(uuid4()),'expectedRevision':details['revision'],'operation':'set_amount','cardKey':card,'amount':'100.123456789123456789','currency':'USD','occurredAt':'2020-01-01T00:00:00+00:00'}
    proof=await wallet.preview(who,data)
    first=await wallet.submit(who,data,proof['preview'])
    deposit={**data,'requestId':str(uuid4()),'expectedRevision':first['revision'],'operation':'deposit','amount':'0.876543210876543211','occurredAt':'2020-01-02T00:00:00+00:00'}
    preview=await wallet.preview(who,deposit)
    receipt=await wallet.submit(who,deposit,preview['preview'])
    backup_id,_=await create_capsule(bc,backup_app,configured)
    raw=(configured.backup_dir/(backup_id+'.enc')).read_bytes()
    assert b'4111111111111111' not in raw and b'100.123456789123456789' not in raw
    response=await bc.get(P+'/backups/'+backup_id+'/restore-preview',params={'target_id':'isolated-qa'})
    assert response.status_code==200,response.text
    job,_=await submit(bc,'backup.restore',backup_id=backup_id,target_id='isolated-qa',restore_ticket=response.json()['restore_ticket'])
    restored=await execute(backup_app,configured,UUID(job['id']))
    assert restored['sessions_revoked']
    target=configured.restore_targets[0]
    restored_settings=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'connection_secret_dir':target.recovery_directory/'connection-secrets','file_root':target.recovery_directory/'files','restore_targets':[]})
    target_app=create_app(restored_settings)
    async with target_app.router.lifespan_context(target_app),httpx.AsyncClient(transport=httpx.ASGITransport(app=target_app),base_url='http://testserver',headers={'origin':'http://testserver'}) as recovered:
        login=await recovered.post(P+'/session/login',json={'login':'BackupQA','password':'Synthetic9Pass'})
        assert login.status_code==200,login.text
        recovered.headers['x-csrf-token']=login.json()['csrf']
        snapshot=await recovered.get('/api/account/card-wallet',params={'cardKey':card})
        from decimal import Decimal
        assert Decimal(snapshot.json()['accounts'][0]['amount'])==101
        revealed=await recovered.post('/api/account/card-wallet/details/reveal',json={'cardKey':card,'reveal':True})
        assert revealed.status_code==200 and revealed.json()['cvv']=='9876',revealed.text
        assert (await recovered.get('/api/account/card-wallet/operations/'+receipt['requestId'])).json()==receipt
        assert (await recovered.post('/api/account/card-wallet/operations',json={'data':data,'preview':proof['preview']})).json()==first
        # UUID replay returns original evidence without executing another posting.
        async with target_app.state.db.connection() as conn:
            assert (await(await conn.execute('SELECT count(*) AS n FROM card_wallet_entries WHERE owner_id=%s',(who.id,))).fetchone())['n']==1
            assert (await(await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries WHERE owner_id=%s',(who.id,))).fetchone())['n']==0
            assert (await(await conn.execute('SELECT crypto_instance FROM card_wallet_details WHERE owner_id=%s',(who.id,))).fetchone())['crypto_instance']==configured.instance_id
