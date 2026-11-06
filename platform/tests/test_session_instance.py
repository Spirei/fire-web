async def test_session_identifies_the_verified_platform_instance(client, admin, settings):
    result = (await client.get("/api/session")).json()
    assert result["instance_id"] == str(settings.instance_id)
    assert result["user"]["id"] == admin
    assert "token_hash" not in result["user"]
    assert "password_hash" not in result["user"]


async def test_reads_reject_a_cookie_from_another_login_before_returning_preferences(client, admin, settings):
    from alcor_api.cli import create_user

    original_binding = client.headers["x-csrf-token"]
    assert (await client.get("/api/account/preferences")).status_code == 200
    other_id = await create_user(settings, "OtherAccount", "Synthetic9Pass", role="user")
    login = await client.post(
        "/api/session/login", json={"login": "OtherAccount", "password": "Synthetic9Pass"}
    )
    assert login.status_code == 200
    # The browser's shared cookie changed, while the older tab still displays AdminOne.
    for path in ("/api/profile", "/api/account/preferences", "/api/session"):
        response = await client.get(path)
        assert response.status_code == 403, response.text
        assert response.headers.get("x-alcor-session-changed") == "true"
        assert other_id not in response.text
    # Session discovery and older clients without the optional read binding remain compatible.
    del client.headers["x-csrf-token"]
    assert (await client.get("/api/session")).json()["user"]["id"] == other_id
    client.headers["x-csrf-token"] = login.json()["csrf"]
    assert client.headers["x-csrf-token"] != original_binding
    assert (await client.get("/api/account/preferences")).status_code == 200
