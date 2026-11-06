"""New Web email signup uses the same PG proof/account rules as legacy clients."""

import json

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.routing import APIRoute
from pydantic import Field, SecretStr

from .identity_email import normalized_email
from .models import InputModel, SessionOut
from .profile_http import bounded_body
from .resource_api import no_duplicate_object
from .security import digest, trusted_origin


async def registration_budget(request, db, rate_limit, *, confirm=False):
    label = "register-confirm" if confirm else "register"
    address = request.client.host if request.client else "unknown"
    for key, limit in (
        (digest("identity-mail:" + label + ":ip:" + address), 20),
        ("identity-mail:" + label + ":global", 400),
    ):
        if not await rate_limit(db, key, limit, window_seconds=900):
            raise HTTPException(429, "尝试过于频繁，请稍后再试")


async def recipient_budget(db, rate_limit, email):
    if not await rate_limit(db, digest("registration-mail-recipient:" + email), 1, window_seconds=60):
        raise HTTPException(429, "请在60秒后重试")
    if not await rate_limit(db, digest("registration-mail-day:" + email), 10, window_seconds=86400):
        raise HTTPException(429, "发送过于频繁")


class RegistrationEmail(InputModel):
    email: str = Field(min_length=1, max_length=254)


class RegistrationEmailConfirm(RegistrationEmail):
    setup_token: SecretStr | None = Field(default=None, max_length=512)
    challenge: SecretStr = Field(min_length=1, max_length=128)
    code: SecretStr = Field(min_length=6, max_length=6)
    password: SecretStr = Field(min_length=1, max_length=128)


class RegistrationEmailChallenge(InputModel):
    email: str
    challenge: str
    expires_in: int
    retry_after: int


class RegistrationRoute(APIRoute):
    def get_route_handler(self):
        native = super().get_route_handler()

        async def handle(request):
            def invalid_constant(_):
                raise ValueError()

            try:
                raw = json.loads(
                    await bounded_body(request, 8192),
                    object_pairs_hook=no_duplicate_object,
                    parse_constant=invalid_constant,
                )
                if not isinstance(raw, dict):
                    raise TypeError()
            except (ValueError, TypeError, UnicodeError):
                raise HTTPException(422, "注册请求格式无效") from None
            return await native(request)

        return handle


def mount_web_email_registration(app, settings, db, create_session, session_response, rate_limit):
    router = APIRouter(prefix="/api/session/register/email", tags=["session"], route_class=RegistrationRoute)

    @router.post("/request", response_model=RegistrationEmailChallenge)
    async def request_code(data: RegistrationEmail, request: Request, response: Response):
        trusted_origin(request)
        await registration_budget(request, db, rate_limit)
        email = normalized_email(data.email)
        await recipient_budget(db, rate_limit, email)
        # The legacy mount owns this shared service and durable identity-mail queue.
        # No adapter sends SMTP directly or substitutes a legacy browser session.
        result = await app.state.identity_email.request_registration(email)
        response.headers["Cache-Control"] = "no-store"
        return result

    @router.post("/confirm", status_code=201, response_model=SessionOut)
    async def confirm_email(data: RegistrationEmailConfirm, request: Request, response: Response):
        trusted_origin(request)
        await registration_budget(request, db, rate_limit, confirm=True)
        user, token, session = await app.state.identity_email.confirm_registration(
            normalized_email(data.email),
            data.challenge.get_secret_value(),
            data.code.get_secret_value(),
            data.password.get_secret_value(),
            request.state.request_id,
            create_session,
            setup_token=data.setup_token.get_secret_value() if data.setup_token else None,
        )
        response.headers["Cache-Control"] = "no-store"
        return session_response(response, user, token, session)

    app.include_router(router)
