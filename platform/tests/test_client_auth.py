import base64
import hashlib
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
from alcor_api import __version__
from alcor_api.cli import create_user

P = "/api"
VERIFIER = "aBcd_123-" * 6
CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")
CALLBACK = "http://127.0.0.1:9876/callback"
SCOPES = ["profile.read", "profile.write", "activity.read"]


async def register(client, cid="qa-client", **changes):
    data = {"name": "QA Client", "redirect_uris": [CALLBACK], "scopes": SCOPES, "revision": None} | changes
    result = await client.put(P + "/clients/" + cid, json=data)
    assert result.status_code == 200, result.text
    return result.json()


async def consent(client, cid="qa-client", scopes=None, **changes):
    data = {
        "request_id": str(uuid4()),
        "client_id": cid,
        "redirect_uri": CALLBACK,
        "scopes": scopes or ["profile.read"],
        "state": "state-1234567890123456",
        "code_challenge": CHALLENGE,
        "code_challenge_method": "S256",
        "device_name": "QA Device",
        "approve": True,
    } | changes
    response = await client.post(P + "/connect/authorize", json=data)
    assert response.status_code == 200, response.text
    return parse_qs(urlsplit(response.json()["redirect_uri"]).query), data


async def exchange(client, code, **changes):
    return await client.post(
        P + "/connect/token",
        data={
            "grant_type": "authorization_code",
            "client_id": "qa-client",
            "redirect_uri": CALLBACK,
            "code_verifier": VERIFIER,
            "code": code,
        }
        | changes,
    )


async def grant(client, scopes=None, **changes):
    code, _data = await consent(client, scopes=scopes, **changes)
    response = await exchange(client, code["code"][0])
    assert response.status_code == 200, response.text
    return response.json()


async def test_version_history_and_real_discovery(client):
    versions = await client.get(P + "/versions")
    assert versions.status_code == 200 and versions.json()["version"] == __version__
    records = versions.json()["releases"]
    assert __version__ in {r["version"] for r in records}
    assert len({r["version"] for r in records}) == len(records)
    assert records == sorted(records, key=lambda r: tuple(map(int, r["version"].split("."))), reverse=True)
    discovery = (await client.get(P + "/connect/config")).json()
    assert discovery["code_challenge_methods_supported"] == ["S256"]
    assert discovery["legacy_ios_compatible"] is False


async def test_registry_cas_reserved_ids_and_no_admin_scope(client, admin):
    created = await register(client)
    assert (
        await client.put(
            P + "/clients/qa-client",
            json={
                "name": "Changed",
                "redirect_uris": [CALLBACK],
                "scopes": ["profile.read"],
                "revision": None,
            },
        )
    ).status_code == 409
    for cid, changes in [
        ("fire-ios", {}),
        ("unknown", {"scopes": ["admin"]}),
        ("unknown", {"redirect_uris": ["https://evil.invalid/*"]}),
        ("unknown", {"redirect_uris": ["http://remote.invalid/callback"]}),
    ]:
        body = {
            "name": "Bad",
            "redirect_uris": [CALLBACK],
            "scopes": ["profile.read"],
            "revision": None,
        } | changes
        assert (await client.put(P + "/clients/" + cid, json=body)).status_code == 422
    updated = await register(client, revision=created["revision"], active=False)
    assert updated["revision"] != created["revision"]


async def test_pkce_exact_callback_and_cookie_scope_boundaries(client, admin):
    await register(client)
    response = await client.get(
        P + "/connect/authorize",
        params={
            "client_id": "qa-client",
            "redirect_uri": CALLBACK + "/bad",
            "scope": "profile.read",
            "state": "state-1234567890123456",
            "code_challenge": CHALLENGE,
            "code_challenge_method": "S256",
        },
    )
    assert response.status_code == 422 and "redirect_uri" not in response.json()
    code, _ = await consent(client)
    assert (await exchange(client, code["code"][0], code_verifier="z" * 43)).status_code == 400
    assert (await exchange(client, code["code"][0], redirect_uri=CALLBACK + "/bad")).status_code == 400
    token = (await exchange(client, code["code"][0])).json()
    headers = {"Authorization": "Bearer " + token["access_token"]}
    profile = await client.get(P + "/connect/profile", headers=headers)
    assert profile.status_code == 200 and profile.json()["username"] == "AdminOne"
    assert (await client.get(P + "/connect/profile")).status_code == 401
    assert (
        await client.patch(
            P + "/connect/profile", headers=headers, json={"display_name": "No write", "revision": None}
        )
    ).status_code == 403
    assert (await client.get(P + "/connect/activity", headers=headers)).status_code == 403
    async with httpx.AsyncClient(transport=client._transport, base_url="http://testserver") as native:
        assert (await native.get(P + "/system/overview", headers=headers)).status_code == 401


async def test_scoped_profile_writes_share_domain_and_conflict_protection(client, admin):
    await register(client)
    token = await grant(client, SCOPES)
    headers = {"Authorization": "Bearer " + token["access_token"]}
    saved = await client.patch(
        P + "/connect/profile", headers=headers, json={"display_name": "Scoped owner", "revision": None}
    )
    assert saved.status_code == 200, saved.text
    assert (await client.get(P + "/profile")).json()["display_name"] == "Scoped owner"
    assert (
        await client.patch(
            P + "/connect/profile", headers=headers, json={"display_name": "Stale", "revision": None}
        )
    ).status_code == 409
    assert (await client.get(P + "/connect/activity", headers=headers)).status_code == 200


async def test_device_revocation_is_owned_and_independent(client, admin, settings, app):
    await register(client)
    first = await grant(client, device_name="First")
    second = await grant(client, device_name="Second")
    rows = (await client.get(P + "/grants")).json()["items"]
    first_id = next(r["id"] for r in rows if r["device_name"] == "First")
    await create_user(settings, "Peer", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        session = (
            await peer.post(P + "/session/login", json={"login": "Peer", "password": "Synthetic9Pass"})
        ).json()
        peer.headers["x-csrf-token"] = session["csrf"]
        assert (await peer.get(P + "/clients")).status_code == 403
        assert (await peer.get(P + "/grants")).json()["items"] == []
        assert (await peer.post(P + "/grants/" + first_id + "/revoke")).status_code == 404
    assert (await client.post(P + "/grants/" + first_id + "/revoke")).status_code == 200
    assert (
        await client.get(P + "/connect/profile", headers={"Authorization": "Bearer " + first["access_token"]})
    ).status_code == 401
    assert (
        await client.get(
            P + "/connect/profile", headers={"Authorization": "Bearer " + second["access_token"]}
        )
    ).status_code == 200


async def test_rotating_refresh_detects_reuse_and_never_stores_plaintext(client, admin, db):
    await register(client)
    original = await grant(client)
    rotated = await client.post(
        P + "/connect/token",
        data={
            "grant_type": "refresh_token",
            "client_id": "qa-client",
            "refresh_token": original["refresh_token"],
        },
    )
    assert rotated.status_code == 200, rotated.text
    async with db.connection() as conn:
        rows = await (await conn.execute("SELECT * FROM client_tokens")).fetchall()
    assert original["refresh_token"] not in str(rows) and original["access_token"] not in str(rows)
    assert (
        await client.post(
            P + "/connect/token",
            data={
                "grant_type": "refresh_token",
                "client_id": "qa-client",
                "refresh_token": original["refresh_token"],
            },
        )
    ).status_code == 400
    assert (
        await client.get(
            P + "/connect/profile", headers={"Authorization": "Bearer " + rotated.json()["access_token"]}
        )
    ).status_code == 401


async def test_code_replay_revokes_issued_family(client, admin):
    await register(client)
    codes, _ = await consent(client)
    token = (await exchange(client, codes["code"][0])).json()
    assert (await exchange(client, codes["code"][0])).status_code == 400
    assert (
        await client.get(P + "/connect/profile", headers={"Authorization": "Bearer " + token["access_token"]})
    ).status_code == 401


async def test_client_disable_and_account_version_revoke_tokens(client, admin, db):
    created = await register(client)
    token = await grant(client)
    codes, _ = await consent(client)
    await register(client, revision=created["revision"], active=False)
    assert (await exchange(client, codes["code"][0])).status_code == 400
    assert (
        await client.get(P + "/connect/profile", headers={"Authorization": "Bearer " + token["access_token"]})
    ).status_code == 401
    item = (await client.get(P + "/clients")).json()["items"][0]
    await register(client, revision=item["revision"])
    token = await grant(client)
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET session_version=session_version+1 WHERE id=%s", (admin,))
    assert (
        await client.get(P + "/connect/profile", headers={"Authorization": "Bearer " + token["access_token"]})
    ).status_code == 401


async def test_cors_is_exact_and_bound_to_the_tokens_client(client, admin):
    await register(client)
    await register(client, cid="other-client", redirect_uris=["https://other.invalid/callback"])
    token = await grant(client)
    preflight = await client.options(
        P + "/connect/profile",
        headers={
            "origin": "http://127.0.0.1:9876",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
        },
    )
    assert (
        preflight.status_code == 204
        and preflight.headers["access-control-allow-origin"] == "http://127.0.0.1:9876"
    )
    assert "access-control-allow-credentials" not in preflight.headers
    assert (
        await client.get(
            P + "/connect/profile",
            headers={"origin": "https://other.invalid", "Authorization": "Bearer " + token["access_token"]},
        )
    ).status_code == 403
    assert (
        await client.get(
            P + "/connect/profile",
            headers={"origin": "https://evil.invalid", "Authorization": "Bearer " + token["access_token"]},
        )
    ).status_code == 403


async def test_denial_expiry_and_csrf_leave_no_live_grant(client, admin, db):
    await register(client)
    denied, _ = await consent(client, approve=False)
    assert denied["error"] == ["access_denied"] and "code" not in denied
    codes, _ = await consent(client)
    async with db.connection() as conn:
        await conn.execute("UPDATE authorization_codes SET expires_at=clock_timestamp()-interval '1 second'")
    assert (await exchange(client, codes["code"][0])).status_code == 400
    assert (
        await client.post(P + "/grants/" + str(uuid4()) + "/revoke", headers={"x-csrf-token": "bad"})
    ).status_code == 403
    assert (await client.get(P + "/grants")).json()["items"] == []
