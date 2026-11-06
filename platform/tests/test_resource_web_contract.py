from uuid import uuid4

from resource_test_support import resource_files, setup  # noqa:F401


async def test_web_discovery_uses_cookie_and_serves_only_own_original_bytes(client, db):
    await setup(client, db)
    response = await client.post(
        "/api/session/login", json={"login": "DeviceOwner", "password": "SyntheticDevicePassword9"}
    )
    assert response.status_code == 200, response.text
    client.headers["x-csrf-token"] = response.json()["csrf"]
    discovery = await client.get("/api/resource-library")
    assert discovery.status_code == 200
    assert discovery.json()["download_auth"] == "cookie"
    source = b"original resource\r\n"
    posted = await client.post(
        "/api/resource-library/files",
        data={"requestId": str(uuid4()), "category": "components", "name": "source.txt"},
        files={"file": ("source.txt", source, "text/plain")},
    )
    assert posted.status_code == 201, posted.text
    path = posted.json()["result"]["downloadPath"]
    downloaded = await client.get(path)
    assert downloaded.status_code == 200 and downloaded.content == source
    assert (await client.get(path, headers={"authorization": "Bearer invalid"})).status_code == 403


async def test_system_file_search_is_literal_owner_bound_and_cursor_bound(client, db):
    from resource_test_support import upload
    from test_legacy_devices import bearer, grant, register
    uid, pair, read, base = await setup(client, db)
    names = ["literal%_中文-1.txt", "literal%_中文-2.txt", "literalZZ中文.txt"]
    for filename in names:
        response, _ = await upload(client, base, pair, filename)
        assert response.status_code == 201, response.text
    # Same library, not a second filesystem or copied index.
    response = await client.get(base + "/files", params={"q": "%_中文", "sort": "name", "direction": "asc", "limit": "1"}, headers=bearer(read))
    assert response.status_code == 200, response.text
    first = response.json()
    assert [row["name"] for row in first["items"]] == names[:1]
    cursor = first["nextCursor"]
    response = await client.get(base + "/files", params={"q": "%_中文", "sort": "name", "direction": "asc", "limit": "1", "cursor": cursor}, headers=bearer(read))
    assert [row["name"] for row in response.json()["items"]] == names[1:2]
    assert (await client.get(base + "/files", params={"q": "other", "sort": "name", "direction": "asc", "cursor": cursor}, headers=bearer(read))).status_code == 400
    assert (await client.get(base + "/files", params={"sort": "name", "direction": "asc", "cursor": cursor}, headers=bearer(read))).status_code == 400
    for invalid in ("", " trailing ", "x" * 121, "line\nfeed"):
        assert (await client.get(base + "/files", params={"q": invalid}, headers=bearer(read))).status_code == 400
    other = await register(client, "SystemFileOther")
    other_read = await grant(db, other, "portfolio.read resources.read")
    assert (await client.get(base + "/files", params={"q": "%_中文"}, headers=bearer(other_read))).json()["items"] == []
    assert (await client.get(base + "/files", params={"q": "%_中文", "sort": "name", "direction": "asc", "cursor": cursor}, headers=bearer(other_read))).status_code == 400
