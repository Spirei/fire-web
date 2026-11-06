import asyncio

import httpx
from alcor_api.cli import create_user
from alcor_api.main import create_app
from test_account_admin import login

P = "/api/account/preferences"


def appearance():
    palette = {
        "theme": "meta",
        "style": "meta",
        "accent": "blue",
        "customAccent": "#4166E9",
        "background": None,
        "foreground": None,
        "font": "system",
    }
    return {
        "version": 1,
        "assetBrokerOrder": [],
        "assetMarketOrder": ["US", "HK", "CN", "JP", "KR", "SG", "UK", "DE", "FR", "AU", "CA", "IN", "TW", "BR"],
        "fxOrder": ["USD", "EUR", "HKD", "CNY", "JPY", "KRW", "SGD", "GBP", "AUD", "CAD", "TWD", "CHF", "INR", "BRL"],
        "fxHidden": [],
        "mode": "dark",
        "separateModes": False,
        "shared": palette,
        "light": palette,
        "dark": palette,
        "uiSize": 14,
        "contentSize": 14,
        "codeSize": 12,
        "motion": "off",
        "translucent": True,
        "contrast": 45,
        "fullWidth": False,
        "contentWidth": "standard",
        "contentAlign": "left",
        "sidebarCollapsed": True,
        "pointer": True,
        "smoothing": True,
        "uiStyle": "regular",
        "contentStyle": "regular",
        "codeStyle": "regular",
        "contentFont": "same",
        "codeFont": "system",
    }


async def test_preferences_persist_in_pg_across_new_api_instance_and_login(client, admin, settings, db):
    initial = await client.get(P)
    assert initial.json() == {"appearance": None, "avatar_status": "online", "revision": None}
    result = await client.patch(
        P, json={"revision": None, "appearance": appearance(), "avatar_status": "focus"}
    )
    assert result.status_code == 200, result.text
    saved = result.json()
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT appearance,avatar_status FROM account_preferences WHERE user_id=%s", (admin,)
            )
        ).fetchone()
        assert row["appearance"] == appearance() and row["avatar_status"] == "focus"
    fresh = create_app(settings)
    async with fresh.router.lifespan_context(fresh):
        second = await login(fresh, "AdminOne")
        try:
            assert (await second.get(P)).json() == saved
        finally:
            await second.aclose()


async def test_preference_ownership_csrf_validation_and_optimistic_versions(client, admin, settings, app):
    await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    peer = await login(app)
    try:
        first = await client.patch(P, json={"revision": None, "avatar_status": "doNotDisturb"})
        assert first.status_code == 200
        assert (await peer.get(P)).json()["revision"] is None
        assert (await client.patch(P, json={"revision": None, "avatar_status": "online"})).status_code == 409
        assert (
            await client.patch(
                P, json={"revision": first.json()["revision"], "user_id": "other", "avatar_status": "online"}
            )
        ).status_code == 422
        assert (
            await client.patch(
                P, json={"revision": first.json()["revision"], "appearance": appearance() | {"uiSize": 999}}
            )
        ).status_code == 422
        assert (
            await client.patch(P, json={"revision": first.json()["revision"], "avatar_status": None})
        ).status_code == 422
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            cookies=client.cookies,
            headers={"origin": "http://testserver"},
        ) as no_csrf:
            assert (
                await no_csrf.patch(P, json={"revision": first.json()["revision"], "avatar_status": "online"})
            ).status_code == 403
        assert (await peer.get(P)).json()["avatar_status"] == "online"
    finally:
        await peer.aclose()


async def test_concurrent_first_saves_cannot_silently_overwrite_each_other(client, admin):
    results = await asyncio.gather(
        *(
            client.patch(P, json={"revision": None, "avatar_status": status})
            for status in ["focus", "doNotDisturb"]
        )
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    winner = next(r.json() for r in results if r.status_code == 200)
    assert (await client.get(P)).json() == winner


async def test_old_appearance_clients_preserve_fx_order_and_hidden_and_invalid_changes_fail_closed(client, admin):
    chosen=appearance() | {"fxOrder":["JPY","USD","EUR"],"fxHidden":["EUR"]}
    first=await client.patch(P,json={"revision":None,"appearance":chosen})
    assert first.status_code==200,first.text
    legacy=appearance()
    del legacy["fxOrder"]
    del legacy["fxHidden"]
    legacy["mode"]="light"
    result=await client.patch(P,json={"revision":first.json()["revision"],"appearance":legacy})
    assert result.status_code==200,result.text
    saved=result.json()
    assert saved["appearance"]["mode"]=="light"
    assert saved["appearance"]["fxOrder"]==["JPY","USD","EUR"]
    assert saved["appearance"]["fxHidden"]==["EUR"]
    for invalid in ({"fxOrder":["USD","USD"]},{"fxHidden":["USD","USD"]},{"fxOrder":["USD"],"fxHidden":["USD"]},{"fxOrder":["usd"]}):
        rejected=await client.patch(P,json={"revision":saved["revision"],"appearance":chosen | invalid})
        assert rejected.status_code==422,rejected.text
        assert (await client.get(P)).json()==saved
    for partial in (legacy | {"fxHidden":["JPY","USD","EUR"]}, legacy | {"fxOrder":["EUR"]}):
        rejected=await client.patch(P,json={"revision":saved["revision"],"appearance":partial})
        assert rejected.status_code==422,rejected.text
        assert (await client.get(P)).json()==saved
