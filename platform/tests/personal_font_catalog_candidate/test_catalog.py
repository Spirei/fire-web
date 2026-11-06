import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from alcor_api.cli import create_user
from alcor_api.main import create_app
from font_fixtures import font_bytes
from personal_font_catalog_candidate.conftest import OTHER
from personal_font_source_candidate.test_source_fonts import P, consent, preview, ready
from test_account_admin import body_for, login

C = P + "/catalogs"


async def catalog(client, old_pg, maximum=5000):
    command = {"requestId": str(uuid4()), "sourceAlias": old_pg.alias, "maxEntries": maximum}
    response = await client.post(C, json=command)
    assert response.status_code == 200, response.text
    return response.json(), command


async def test_actual_metadata_catalog_never_opens_font_or_sidecar_bytes_and_does_not_infer_owner(
    client, admin, old_pg, source_file, app, monkeypatch
):
    from alcor_api import font_source_catalog as module

    original = module.os.open

    def no_font_open(path, flags, *args, **kwargs):
        assert not str(path).endswith((".ttf", ".json")), "inventory opened original content"
        return original(path, flags, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(module.os, "open", no_font_open)
        result, command = await catalog(client, old_pg)
    response = await client.get(C + "/" + result["catalogId"])
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["counts"]["knownItems"] == 1 and page["counts"]["unassigned"] == 1
    assert page["counts"]["archived"] == 0 and page["ignored"] == 1
    item = page["items"][0]
    assert item["assignmentState"] == "unassigned" and item["ownerId"] is None
    assert item["originalId"].startswith("custom-783-") and item["size"] == len(source_file[2])
    assert not item["contentVerified"] and not item["historicalUploaderVerified"]
    assert not page["entireSourceComplete"] and page["scanState"] == "sealed"
    assert str(source_file[0]) not in response.text and "password" not in response.text
    assert (await client.get(P + "/catalog-operations/" + command["requestId"])).json() == result
    assert (await client.post(C, json=command)).json() == result
    async with app.state.db.connection() as conn:
        for table in (
            "personal_fonts",
            "resource_media_objects",
            "legacy_source_owner_claims",
            "legacy_source_heads",
        ):
            assert (await (await conn.execute("SELECT count(*) n FROM " + table)).fetchone())["n"] == 0


async def test_truncated_and_unsafe_metadata_remain_explicit_and_current_pg_mapping_counts_are_real(
    client, admin, old_pg, source_file, app
):
    for n in range(3):
        raw = font_bytes(seed=n + 2)
        digest = __import__("hashlib").sha256(raw).hexdigest()
        path = source_file[0] / ("custom-" + str(n + 20) + "-" + digest + ".ttf")
        path.write_bytes(raw)
    fake = source_file[0] / ("custom-884-" + "a" * 64 + ".ttf")
    fake.symlink_to(source_file[1])
    result, _ = await catalog(client, old_pg, 1)
    partial = (await client.get(C + "/" + result["catalogId"])).json()
    assert partial["truncated"] and partial["visited"] == 1 and partial["scanState"] == "truncated"
    assert not partial["entireSourceComplete"]
    full, _ = await catalog(client, old_pg)
    page = (await client.get(C + "/" + full["catalogId"], params={"limit": 2})).json()
    assert page["counts"]["knownItems"] == 5 and page["counts"]["sourceBlocked"] == 1
    assert len(page["items"]) == 2 and page["nextAfter"] == 1
    rest = (await client.get(C + "/" + full["catalogId"], params={"after": page["nextAfter"]})).json()
    assert len(rest["items"]) == 3 and rest["nextAfter"] is None
    blocked = next(item for item in page["items"] + rest["items"] if item["metadataState"] == "blocked")
    assert blocked["reason"] == "not_safe_regular_original" and not blocked["contentVerified"]
    _, cap, _ = await ready(client, admin, old_pg, source_file)
    applied = await client.post(P + "/operations", json=await preview(client, cap))
    assert applied.status_code == 200, applied.text
    updated = (await client.get(C + "/" + full["catalogId"])).json()
    assert updated["counts"]["archived"] == updated["counts"]["mapped"] == 1
    assert updated["counts"]["unassigned"] == 4


async def test_catalog_register_is_exact_snapshot_and_grant_then_owner_flow_is_same_service(
    client, admin, old_pg, source_file
):
    from legacy_source.test_source_authority import authorized

    result, _ = await catalog(client, old_pg)
    page = (await client.get(C + "/" + result["catalogId"])).json()
    grant = await authorized(client, admin, old_pg)
    command = {
        "requestId": str(uuid4()),
        "grantId": grant["grantId"],
        "grantRevision": grant["grantRevision"],
        "evidenceRef": "Explicit operator and owner review",
    }
    path = C + "/" + result["catalogId"] + "/entries/" + str(page["items"][0]["ordinal"]) + "/registrations"
    registration = await client.post(path, json=command)
    assert registration.status_code == 200, registration.text
    p = registration.json()["permission"]
    assert p["originalId"] == source_file[1].name and p["evidenceRef"].startswith("catalog:")
    p = await consent(client, p)
    assert p["state"] == "active" and not p["historicalUploaderVerified"]
    changed = {**command, "requestId": str(uuid4()), "originalId": "not-from-catalog"}
    assert (await client.post(path, json=changed)).status_code == 422


async def test_expired_and_offline_root_preserves_catalog_and_dynamic_archived_state_no_new_listing(
    client, admin, old_pg, source_file, settings
):
    result, _ = await catalog(client, old_pg)
    _, cap, _ = await ready(client, admin, old_pg, source_file)
    doc = json.loads(settings.legacy_source_registry_path.read_bytes())
    doc["sources"][0]["migrationWindow"] = {
        "notBefore": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
        "expiresAt": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
        "state": "active",
    }
    settings.legacy_source_registry_path.write_text(json.dumps(doc))
    source_file[0].rename(source_file[0].with_name("offline-font-root"))
    assert (
        await client.post(C, json={"requestId": str(uuid4()), "sourceAlias": old_pg.alias, "maxEntries": 100})
    ).status_code == 409
    page = await client.get(C + "/" + result["catalogId"])
    assert page.status_code == 200 and page.json()["counts"]["archived"] == 1
    assert (await client.get(C)).json()["items"][0]["id"] == result["catalogId"]
    applied = await client.post(P + "/operations", json=await preview(client, cap))
    assert applied.status_code == 200, applied.text


async def test_original_catalog_cancel_race_rejects_late_snapshot_and_no_other_owner_can_read(
    client, admin, old_pg, source_file, app, settings
):
    entered, release = asyncio.Event(), asyncio.Event()

    async def paused():
        entered.set()
        await release.wait()

    app.state.font_source_catalog.after_read = paused
    command = {"requestId": str(uuid4()), "sourceAlias": old_pg.alias, "maxEntries": 5000}
    running = asyncio.create_task(client.post(C, json=command))
    await asyncio.wait_for(entered.wait(), 10)
    closed = await client.post(
        P + "/catalog-operations/" + command["requestId"] + "/close", json={"expectedKind": "catalog"}
    )
    assert closed.status_code == 200 and closed.json()["canceled"]
    release.set()
    assert (await running).json() == closed.json()
    assert (await client.get(C)).json()["items"] == []
    await create_user(settings, "CatalogPrivateMember", "Synthetic9Pass", role="user")
    peer = await login(app, "CatalogPrivateMember")
    assert (await peer.get(C)).status_code == 403
    assert (await peer.get(P + "/catalog-operations/" + command["requestId"])).status_code == 403
    await peer.aclose()


async def test_closed_owner_cannot_release_file_claim_or_global_catalog_and_alias_cannot_reassign(
    client, admin, old_pg, source_file, app, settings
):
    result, _ = await catalog(client, old_pg)
    _, cap, _ = await ready(client, admin, old_pg, source_file)
    assert (await client.post(P + "/operations", json=await preview(client, cap))).status_code == 200
    survivor = await create_user(settings, "CatalogSurvivingAdmin", "Synthetic9Pass", role="admin")
    peer = await login(app, "CatalogSurvivingAdmin")
    before = await body_for(client, admin)
    closed = await client.post(
        "/api/account/close",
        json={k: before[k] for k in ("request_id", "revision")} | {"current_password": "Synthetic9Pass"},
    )
    assert closed.status_code == 200, closed.text

    async def grant_to_other(c, alias):
        registered = await c.post(
            "/api/legacy-financial/authorizations",
            json={
                "requestId": str(uuid4()),
                "sourceAlias": alias,
                "sourceOwner": OTHER,
                "targetUserId": survivor,
            },
        )
        assert registered.status_code == 200, registered.text
        g = registered.json()
        approved = await c.post(
            "/api/legacy-financial/authorizations/" + g["grantId"] + "/consent",
            json={
                "requestId": str(uuid4()),
                "revision": g["grantRevision"],
                "password": "Synthetic9Pass",
                "code": "",
                "approve": True,
            },
        )
        assert approved.status_code == 200, approved.text
        return approved.json()

    g = await grant_to_other(peer, old_pg.alias)
    blocked = await peer.post(
        P + "/permissions",
        json={
            "requestId": str(uuid4()),
            "grantId": g["grantId"],
            "grantRevision": g["grantRevision"],
            "originalId": source_file[1].name,
            "evidenceRef": "Explicit but conflicting reassignment",
        },
    )
    assert blocked.status_code == 409 and "永久" in blocked.text
    assert (await peer.get(C + "/" + result["catalogId"])).json()["counts"]["ownerClosed"] == 1
    revoked = await peer.post(
        "/api/legacy-financial/authorizations/" + g["grantId"] + "/consent",
        json={
            "requestId": str(uuid4()),
            "revision": g["grantRevision"],
            "password": "Synthetic9Pass",
            "code": "",
            "approve": False,
        },
    )
    assert revoked.status_code == 200, revoked.text
    source = json.loads(settings.legacy_source_registry_path.read_bytes())
    alias = {
        **source["sources"][0],
        "alias": "same-root-second-alias",
        "instance": "other-label-same-physical-source",
    }
    source["sources"].append(alias)
    settings.legacy_source_registry_path.write_text(json.dumps(source))
    roots = json.loads(settings.font_import_registry_path.read_bytes())
    roots["roots"].append({**roots["roots"][0], "sourceAlias": alias["alias"]})
    settings.font_import_registry_path.write_text(json.dumps(roots))
    second_app = create_app(settings)
    async with (
        second_app.router.lifespan_context(second_app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=second_app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as second,
    ):
        logged = await second.post(
            "/api/session/login", json={"login": "CatalogSurvivingAdmin", "password": "Synthetic9Pass"}
        )
        second.headers["x-csrf-token"] = logged.json()["csrf"]
        new_grant = await grant_to_other(second, alias["alias"])
        changed = await second.post(
            P + "/permissions",
            json={
                "requestId": str(uuid4()),
                "grantId": new_grant["grantId"],
                "grantRevision": new_grant["grantRevision"],
                "originalId": source_file[1].name,
                "evidenceRef": "Same physical root new alias",
            },
        )
        assert changed.status_code == 409 and "永久" in changed.text
        archived = await second.get(C + "/" + result["catalogId"])
        assert archived.status_code == 200 and archived.json()["counts"]["ownerClosed"] == 1
    assert source_file[1].read_bytes() == source_file[2]
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM personal_font_source_file_claims WHERE owner_id=%s", (admin,)
                )
            ).fetchone()
        )["n"] == 1
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM personal_font_source_permissions WHERE owner_id=%s", (admin,)
                )
            ).fetchone()
        )["n"] == 0
        with pytest.raises(__import__("psycopg").Error):
            async with conn.transaction():
                await conn.execute("DELETE FROM personal_font_source_file_claims WHERE owner_id=%s", (admin,))
    await peer.aclose()


async def test_real_directory_mutation_is_changed_not_a_complete_stable_snapshot(
    client, admin, old_pg, source_file, monkeypatch
):
    from contextlib import contextmanager

    from alcor_api import font_source_catalog as module

    native = module.os.scandir

    @contextmanager
    def changing(fd):
        with native(fd) as iterator:

            def values():
                changed = False
                for entry in iterator:
                    yield entry
                    if not changed:
                        (source_file[0] / "new-item-during-scan").write_text("Synthetic directory change")
                        changed = True

            yield values()

    with monkeypatch.context() as patch:
        patch.setattr(module.os, "scandir", changing)
        result, _ = await catalog(client, old_pg)
    page = (await client.get(C + "/" + result["catalogId"])).json()
    assert page["changed"] and page["scanState"] == "changed" and not page["entireSourceComplete"]


async def test_history_gap_preserves_exact_existing_claim_and_archived_owner_apply(
    client, admin, old_pg, source_file, app
):
    p, cap, _ = await ready(client, admin, old_pg, source_file)
    async with app.state.db.connection() as conn, conn.transaction():
        row = await (
            await conn.execute(
                "SELECT physical_identity_hash FROM personal_font_source_permissions WHERE id=%s", (p["id"],)
            )
        ).fetchone()
        await conn.execute(
            "INSERT INTO personal_font_source_history_gaps(physical_identity_hash) VALUES(%s)",
            (row["physical_identity_hash"],),
        )
    # The gap restricts unknown files, never the positively established exact claim.
    applied = await client.post(P + "/operations", json=await preview(client, cap))
    assert applied.status_code == 200 and applied.json()["state"] == "completed", applied.text
    scan, _ = await catalog(client, old_pg)
    page = (await client.get(C + "/" + scan["catalogId"])).json()
    assert page["items"][0]["assignmentState"] == "mapped"
    assert page["counts"]["historyGap"] == 0 and page["counts"]["mapped"] == 1
    async with app.state.db.connection() as conn:
        grant = await (
            await conn.execute("SELECT id,revision FROM legacy_source_grants WHERE owner_id=%s", (admin,))
        ).fetchone()
    command = {
        "requestId": str(uuid4()),
        "grantId": str(grant["id"]),
        "grantRevision": grant["revision"],
        "originalId": "custom-900-" + "f" * 64 + ".ttf",
        "evidenceRef": "Synthetic new unknown original",
    }
    response = await client.post(P + "/permissions", json=command)
    assert response.status_code == 409 and "history_gap" in response.text, response.text
