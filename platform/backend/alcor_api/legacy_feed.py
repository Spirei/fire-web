"""Literal v1/v2 feed entry points retain separate credential and envelope rules."""

from fastapi import Request


def mount_legacy_feed(app):
    transport = app.state.feed_transport

    def handler(version):
        async def route(request: Request, action: str = ""):
            return await transport.execute(request, action, version=version)
        return route

    for version in (1, 2):
        for path, suffix in (("", "root"), ("/{action:path}", "dispatch")):
            for method in ("GET", "POST", "PUT"):
                app.add_api_route(
                    "/api/v" + str(version) + "/feed" + path, handler(version),
                    methods=[method], operation_id=f"legacy_feed_v{version}_{suffix}_{method.lower()}",
                    tags=["legacy-feed"],
                )
