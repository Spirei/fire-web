import asyncio

import test_personal_fonts as support
from alcor_api.cli import create_user
from test_account_admin import body_for, login
from test_account_preferences import appearance
from test_personal_fonts import P, upload

files = support.files
PREF = "/api/account/preferences"


async def test_owned_fonts_roundtrip_all_palettes_content_and_existing_pg_cas(client, admin, app):
    uploaded, _ = await upload(client)
    font = uploaded.json()["font"]["id"]
    value = appearance()
    for mode in ("shared", "light", "dark"):
        value[mode] = {**value[mode], "font": font}
    value["contentFont"] = font
    first = await client.patch(PREF, json={"revision": None, "appearance": value})
    assert first.status_code == 200, first.text
    assert first.json()["appearance"] == value
    assert (await client.get(PREF)).json() == first.json()
    stale = await client.patch(PREF, json={"revision": None, "appearance": appearance()})
    assert stale.status_code == 409
    assert (await client.get(PREF)).json() == first.json()
    normal = await client.patch(PREF, json={"revision": first.json()["revision"], "appearance": appearance()})
    assert normal.status_code == 200
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT appearance FROM account_preferences WHERE user_id=%s", (admin,))
            ).fetchone()
        )["appearance"] == appearance()


async def test_unknown_foreign_inactive_palette_and_css_values_cannot_enter_owner_preferences(
    client, admin, settings, app
):
    font, _ = await upload(client)
    owned = font.json()["font"]["id"]
    await create_user(settings, "FontPrefMember", "Synthetic9Pass", role="user")
    member = await login(app, "FontPrefMember")
    other, _ = await upload(member)
    foreign = other.json()["font"]["id"]
    for mode in ("shared", "light", "dark", "contentFont"):
        value = appearance()
        if mode == "contentFont":
            value[mode] = foreign
        else:
            value[mode] = {**value[mode], "font": foreign}
        rejected = await client.patch(PREF, json={"revision": None, "appearance": value})
        assert rejected.status_code == 422, rejected.text
        assert (await client.get(PREF)).json()["revision"] is None
    for invalid in [
        owned.replace(owned.split("-")[-1].split(".")[0], "0" * 64),
        "url(https://unapproved.example.invalid/a.woff2)",
        owned + ";color:red",
    ]:
        value = appearance()
        value["shared"]["font"] = invalid
        assert (await client.patch(PREF, json={"revision": None, "appearance": value})).status_code == 422
    value = appearance()
    value["shared"]["font"] = owned
    rejected = await member.patch(PREF, json={"revision": None, "appearance": value})
    assert rejected.status_code == 422
    status = await member.patch(PREF, json={"revision": None, "avatar_status": "focus"})
    assert status.status_code == 200
    await member.aclose()


async def test_font_preference_save_and_actual_member_removal_never_deadlock_or_retain_closed_private_state(
    client, admin, settings, app
):
    owner = await create_user(settings, "FontPrefClosure", "Synthetic9Pass", role="user")
    member = await login(app, "FontPrefClosure")
    uploaded, _ = await upload(member)
    value = appearance()
    value["shared"]["font"] = uploaded.json()["font"]["id"]
    current = await member.patch(PREF, json={"revision": None, "appearance": value})
    assert current.status_code == 200
    target = await body_for(client, owner)
    save, closed = await asyncio.gather(
        member.patch(
            PREF, json={"revision": current.json()["revision"], "appearance": {**value, "uiSize": 16}}
        ),
        client.request(
            "DELETE", "/api/users/" + owner, json={key: target[key] for key in ("request_id", "revision", "current_password")}
        ),
    )
    assert closed.status_code == 200, closed.text
    assert save.status_code in (200, 401), save.text
    assert (await member.get(P)).status_code == 401
    async with app.state.db.connection() as conn:
        for table, field in [("account_preferences", "user_id"), ("personal_fonts", "owner_id")]:
            assert (
                await (
                    await conn.execute(
                        "SELECT count(*) n FROM " + table + " WHERE " + field + "=%s", (owner,)
                    )
                ).fetchone()
            )["n"] == 0
    await member.aclose()
