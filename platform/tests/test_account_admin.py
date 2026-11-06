import asyncio
from uuid import uuid4

import httpx
from alcor_api.cli import create_user
from alcor_api.security import digest

P = "/api"


async def login(app, name="PeerOne", password="Synthetic9Pass"):
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    )
    response = await client.post(P + "/session/login", json={"login": name, "password": password})
    assert response.status_code == 200, response.text
    client.headers["x-csrf-token"] = response.json()["csrf"]
    return client


async def body_for(client, uid, **changes):
    user = next(r for r in (await client.get(P + "/users")).json()["items"] if r["id"] == uid)
    return {
        "request_id": str(uuid4()),
        "revision": user["revision"],
        "role": user["role"],
        "active": user["active"],
        "current_password": "Synthetic9Pass",
    } | changes


async def test_account_owner_and_admin_listing_hide_secrets(client, admin, settings, app):
    uid = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user", email="peer@example.invalid")
    peer = await login(app)
    try:
        own = (await peer.get(P + "/account")).json()
        assert own["id"] == uid and own["email"] == "peer@example.invalid"
        assert "password_hash" not in own and "session_version" not in own
        assert (await peer.get(P + "/users")).status_code == 403
        assert (
            await peer.patch(P + "/users/" + admin, json=await body_for(client, admin, active=False))
        ).status_code == 403
        listed = (await client.get(P + "/users")).json()["items"]
        assert "password_hash" not in str(listed) and "session_version" not in str(listed)
        assert next(row for row in listed if row["id"] == uid)["email"] == "peer@example.invalid"
    finally:
        await peer.aclose()


async def test_admin_search_and_keyset_pages_cover_exact_accounts(client, admin, settings):
    for i in range(5):
        await create_user(settings, "Peer" + str(i), "Synthetic9Pass", role="user")
    seen = []
    cursor = ""
    while True:
        response = await client.get(
            P + "/users",
            params={"q": "Peer", "limit": 2, "cursor": cursor} if cursor else {"q": "Peer", "limit": 2},
        )
        assert response.status_code == 200, response.text
        page = response.json()
        seen.extend(row["username"] for row in page["items"])
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert seen == ["Peer0", "Peer1", "Peer2", "Peer3", "Peer4"]
    assert (await client.get(P + "/users", params={"cursor": "not-valid"})).status_code == 422
    assert (await client.get(P + "/users", params={"q": "' OR 1=1 --"})).json()["items"] == []


async def test_last_active_admin_cannot_be_disabled_or_demoted(client, admin):
    for change in [{"active": False}, {"role": "user"}]:
        response = await client.patch(P + "/users/" + admin, json=await body_for(client, admin, **change))
        assert response.status_code == 409 and "管理员" in response.json()["error"]["message"]
    assert (await client.get(P + "/session")).status_code == 200


async def test_role_changes_are_cas_idempotent_and_receipts_are_owned(client, admin, settings, app):
    uid = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    body = await body_for(client, uid, role="admin")
    first = await client.patch(P + "/users/" + uid, json=body)
    assert first.status_code == 200, first.text
    assert (await client.patch(P + "/users/" + uid, json=body)).json() == first.json()
    assert (await client.patch(P + "/users/" + uid, json=body | {"active": False})).status_code == 409
    stale = body | {"request_id": str(uuid4()), "active": False}
    assert (await client.patch(P + "/users/" + uid, json=stale)).status_code == 409
    assert (await client.get(P + "/users/receipts/" + body["request_id"])).json() == first.json()
    peer = await login(app)
    try:
        assert (await peer.get(P + "/users/receipts/" + body["request_id"])).status_code == 404
    finally:
        await peer.aclose()


async def test_disable_and_reenable_never_revive_old_sessions_or_grants(client, admin, settings, app):
    from test_client_auth import grant, register

    uid = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    peer = await login(app)
    await register(client)
    token = await grant(peer)
    try:
        assert (
            await client.patch(P + "/users/" + uid, json=await body_for(client, uid, active=False))
        ).status_code == 200
        assert (await peer.get(P + "/session")).status_code == 401
        assert (
            await peer.get(
                P + "/connect/profile", headers={"Authorization": "Bearer " + token["access_token"]}
            )
        ).status_code == 401
        assert (
            await client.patch(P + "/users/" + uid, json=await body_for(client, uid, active=True))
        ).status_code == 200
        assert (await peer.get(P + "/session")).status_code == 401
        assert (
            await peer.get(
                P + "/connect/profile", headers={"Authorization": "Bearer " + token["access_token"]}
            )
        ).status_code == 401
        fresh = await login(app)
        await fresh.aclose()
    finally:
        await peer.aclose()


async def test_concurrent_admin_demotions_preserve_one_authority(client, admin, settings, app, db):
    uid = await create_user(settings, "PeerOne", "Synthetic9Pass", role="admin")
    peer = await login(app)
    try:
        a = await body_for(client, uid, role="user")
        b = await body_for(peer, admin, role="user")
        responses = await asyncio.gather(
            client.patch(P + "/users/" + uid, json=a), peer.patch(P + "/users/" + admin, json=b)
        )
        assert sorted(r.status_code for r in responses) == [200, 401]
        async with db.connection() as conn:
            assert (
                await (
                    await conn.execute("SELECT count(*) AS n FROM users WHERE active AND role='admin'")
                ).fetchone()
            )["n"] == 1
    finally:
        await peer.aclose()


async def test_password_change_requires_old_secret_and_revokes_every_old_session(client, admin, app):
    from test_client_auth import grant, register

    peer = await login(app, "AdminOne")
    await register(client)
    token = await grant(client)
    try:
        wrong = await client.post(
            P + "/account/password",
            json={"current_password": "Wrong9Pass", "new_password": "ChangedSynthetic8Pass"},
        )
        assert wrong.status_code == 422 and (await client.get(P + "/session")).status_code == 200
        weak = await client.post(
            P + "/account/password", json={"current_password": "Synthetic9Pass", "new_password": "aaaaaaaa"}
        )
        assert weak.status_code == 422
        changed = await client.post(
            P + "/account/password",
            json={"current_password": "Synthetic9Pass", "new_password": "ChangedSynthetic8Pass"},
        )
        assert changed.status_code == 204, changed.text
        assert (await peer.get(P + "/session")).status_code == 401
        assert (
            await peer.get(
                P + "/connect/profile", headers={"Authorization": "Bearer " + token["access_token"]}
            )
        ).status_code == 401
        assert (
            await peer.post(P + "/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"})
        ).status_code == 401
        assert (
            await peer.post(
                P + "/session/login", json={"login": "AdminOne", "password": "ChangedSynthetic8Pass"}
            )
        ).status_code == 200
    finally:
        await peer.aclose()


async def test_admin_mutations_need_recent_session_or_actual_stepup_and_csrf(client, admin, db):
    body = await body_for(client, admin)
    assert (
        await client.patch(P + "/users/" + admin, json=body, headers={"x-csrf-token": "bad"})
    ).status_code == 403
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes' WHERE token_hash=%s",
            (digest(client.cookies["alcor_session"]),),
        )
    without_proof = {key: value for key, value in body.items() if key != "current_password"}
    assert (await client.patch(P + "/users/" + admin, json=without_proof)).status_code == 403
    assert (await client.patch(P + "/users/" + admin, json=body)).status_code == 200
    assert (await client.get(P + "/users")).status_code == 200


async def test_directory_uses_real_profile_and_factor_with_unknown_financial_count(client, admin, db):
    from psycopg.types.json import Jsonb

    revision = uuid4()
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO user_profiles(user_id,display_name,avatar,revision) VALUES(%s,'Synthetic display',%s,%s)",
            (admin, b"SyntheticAvatarBytes", revision),
        )
        await conn.execute(
            "INSERT INTO identity_source_profiles(user_id,metadata) VALUES(%s,%s)",
            (admin, Jsonb({"uid": "17", "nickname": "Old name", "secret": "NeverReturnThis"})),
        )
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext) VALUES(%s,true,'SyntheticCiphertextNeverReturn')",
            (admin,),
        )
    response = await client.get(P + "/users")
    assert response.status_code == 200, response.text
    user = next(row for row in response.json()["items"] if row["id"] == admin)
    assert user["display_name"] == "Synthetic display" and user["uid"] == "1"
    assert user["avatar_revision"] == str(revision) and user["two_factor_enabled"] is True
    assert user["records_count"] is None
    assert "NeverReturn" not in response.text and "totp_secret" not in response.text
    avatar = await client.get(P + f"/users/{admin}/avatar?revision={revision}")
    assert avatar.status_code == 200 and avatar.content == b"SyntheticAvatarBytes"
    assert avatar.headers["cache-control"] == "no-store"
    assert (await client.get(P + f"/users/{admin}/avatar?revision={uuid4()}")).status_code == 404


async def test_directory_avatar_is_not_public_or_available_to_ordinary_users(client, admin, settings, app):
    await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    peer = await login(app)
    try:
        assert (await peer.get(P + f"/users/{admin}/avatar?revision={uuid4()}")).status_code == 403
        public = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")
        async with public:
            assert (await public.get(P + f"/users/{admin}/avatar?revision={uuid4()}")).status_code == 401
    finally:
        await peer.aclose()
