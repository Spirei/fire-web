"""Independent adversarial checks of canonical preference receipt closure."""

from uuid import uuid4

import httpx
import pytest
from test_card_preference_web import PATH, command


async def test_close_audit_failure_cannot_leave_a_durable_false_tombstone(client, admin, db):
    data = command()
    receipt = PATH + "/operations/" + data["requestId"]
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION card_close_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='cards.request.closed' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$; CREATE TRIGGER card_close_audit_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION card_close_audit_fail()",
            prepare=False,
        )
    result = await client.post(receipt + "/close", json={})
    assert result.status_code == 503
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM card_preference_operations")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM card_preference_collections")).fetchone()
        await conn.execute(
            "DROP TRIGGER card_close_audit_fail ON audit_events; DROP FUNCTION card_close_audit_fail()",
            prepare=False,
        )
    # The failed close did not reserve this original UUID or modify the collection.
    assert (await client.put(PATH, json=data)).status_code == 200


async def test_close_rechecks_session_after_reading_its_body(client, admin, db, monkeypatch):
    import alcor_api.card_preference_web as module

    original = module.bounded_body

    async def revoked(*args):
        raw = await original(*args)
        async with db.connection() as conn:
            await conn.execute("DELETE FROM sessions WHERE user_id=%s", (admin,))
        return raw

    monkeypatch.setattr(module, "bounded_body", revoked)
    result = await client.post(PATH + "/operations/" + str(uuid4()) + "/close", json={})
    assert result.status_code == 401
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM card_preference_operations")).fetchone()
        assert not await (
            await conn.execute("SELECT 1 FROM audit_events WHERE action='cards.request.closed'")
        ).fetchone()


async def test_peer_closing_same_uuid_cannot_close_or_observe_original_owner_operation(
    client, admin, db, app
):
    data = command()
    assert (await client.put(PATH, json=data)).status_code == 200
    receipt = PATH + "/operations/" + data["requestId"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        registered = await peer.post(
            "/api/session/register", json={"username": "ClosePeer", "password": "SyntheticClosePeer9"}
        )
        assert registered.status_code == 201
        peer.headers["x-csrf-token"] = registered.json()["csrf"]
        assert (await peer.get(receipt)).status_code == 404
        assert (await peer.post(receipt + "/close", json={})).json()["state"] == "closed"
    original = await client.get(receipt)
    assert original.status_code == 200 and original.json()["data"]["tags"] == ["Travel"]
    assert "state" not in original.json()
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM card_preference_operations")).fetchone())[
            "n"
        ] == 2


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
async def test_non_json_constants_are_rejected_without_any_preference_operation(client, admin, db, constant):
    raw = (
        '{"requestId":"'
        + str(uuid4())
        + '","expectedRevision":0,"kind":"tags","cardKey":"synthetic","value":['
        + constant
        + "]}"
    ).encode()
    result = await client.put(PATH, content=raw, headers={"content-type": "application/json"})
    assert result.status_code == 400
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM card_preference_operations")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM card_preference_tags")).fetchone()
