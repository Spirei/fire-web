"""Protocol availability is separate from scope, mail readiness and delivery health."""

from urllib.parse import urlsplit

from fastapi import HTTPException

from .identity_mail import mail_configured
from .site_settings import domain


def verification_link_available(settings):
    if settings.environment in {"local", "test"}:
        origin = urlsplit(settings.public_origin)
        return bool(
            origin.scheme in {"http", "https"}
            and origin.netloc
            and not origin.path
            and not origin.query
            and not origin.fragment
            and not origin.username
        )
    try:
        return bool(domain(settings.public_origin))
    except HTTPException:
        return False


async def email_verification_availability(conn, settings):
    blocked = await (
        await conn.execute("SELECT 1 FROM restore_quarantine WHERE category='external_delivery_disabled'")
    ).fetchone()
    return {
        "protocolSupported": True,
        "configured": mail_configured(settings),
        "deliveryAllowed": not bool(blocked),
        "verificationLinkAvailable": verification_link_available(settings),
        "deliveryHealth": "not_checked",
    }


def email_verification_capable(scope, availability):
    scopes = set(scope.split())
    return bool(
        {"security.read", "security.write"} <= scopes
        and availability
        and availability.get("protocolSupported") is True
        and availability.get("configured") is True
        and availability.get("deliveryAllowed") is True
        and availability.get("verificationLinkAvailable") is True
    )


async def native_email_registration_discovery(conn, settings, availability=None):
    from .accounts import registration_status
    from .site_registration import registration_open

    availability = availability or await email_verification_availability(conn, settings)
    state = await registration_status(conn)
    opened = await registration_open(conn)
    # Existing native clients accept ordinary-user registration receipts only.
    # First-account role assignment stays in the shared PG transaction; the new
    # Web supports that bootstrap rather than mislabelling an admin receipt.
    ready = bool(
        opened and not state["first_user"] and availability["configured"] and availability["deliveryAllowed"]
    )
    return {
        "supported": ready,
        "version": 1,
        "request_path": "/api/auth/register/email/request",
        "confirm_path": "/api/auth/register/email/confirm",
        "code_digits": 6,
        "challenge_ttl_seconds": 1800,
        "retry_after_seconds": 60,
        "max_attempts": 5,
        "authentication": "separate_native_login",
        "readiness": {
            "protocolSupported": True,
            "registrationOpen": opened,
            "firstAccountRequiresWeb": state["first_user"],
            "configured": availability["configured"],
            "deliveryAllowed": availability["deliveryAllowed"],
            "deliveryHealth": "not_checked",
        },
    }
