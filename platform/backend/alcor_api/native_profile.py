"""Native canonical profile protocol; users/user_profiles remain sole authority."""

import asyncio

from fastapi import Request

from . import profiles
from .legacy_identity import assert_native_origin, native_identity
from .models import ProfileInput
from .profile_http import profile_limits


def mount_native_profile(app, settings, db, rate_limit):
    async def member(request, scope):
        assert_native_origin(request, settings)
        return (await native_identity(request, db, scope))[0]

    @app.get("/api/client/profile", tags=["client-profile"])
    async def read(request: Request):
        who = await member(request, "portfolio.read")
        async with db.connection() as conn:
            return await profiles.read_profile(conn, who.id)

    @app.patch("/api/client/profile", tags=["client-profile"])
    async def patch(data: ProfileInput, request: Request):
        who = await member(request, "profile.write")
        await profile_limits(request, db, who, rate_limit)
        avatar = (
            await asyncio.to_thread(profiles.normalize_avatar, data.avatar_data)
            if data.avatar_data is not None
            else None
        )
        return await profiles.update_profile(db, who, data, avatar, request.state.request_id)
