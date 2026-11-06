"""Canonical paths delegate to the exact version-2 security handlers and policies."""

import inspect

from fastapi import Request, Response


def mount_security_alias(app, path, methods, handler, *, action=False):
    parameters = inspect.signature(handler).parameters

    async def invoke(request, response, selected=None):
        # Internal ASGI state, never a caller-controlled header or grant downgrade.
        request.state.canonical_security_v2 = True
        args = {"version": 2, "request": request}
        if "response" in parameters:
            args["response"] = response
        if selected is not None:
            args["action"] = selected
        result = await handler(**args)
        response.headers["Cache-Control"] = "no-store, private"
        return (
            result["data"]
            if isinstance(result, dict) and result.get("code") == 0 and "data" in result
            else result
        )

    if action:

        async def endpoint(action: str, request: Request, response: Response):
            return await invoke(request, response, action)
    else:

        async def endpoint(request: Request, response: Response):
            return await invoke(request, response)

    endpoint.__name__ = "client_" + handler.__name__
    app.add_api_route("/api/client/auth" + path, endpoint, methods=methods, tags=["client-security"])
