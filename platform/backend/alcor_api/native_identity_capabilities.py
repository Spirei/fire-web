"""Protocol availability is separate from scope, mail readiness and delivery health."""

from urllib.parse import urlsplit

from fastapi import HTTPException

from .accounts import REGISTRATION_STATUS_QUERY
from .db import TargetMismatch
from .identity_mail import mail_configured
from .site_registration import MIGRATION as SITE_SETTINGS_MIGRATION, installed as site_settings_installed
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
    return email_verification_state(settings, bool(blocked))


def email_verification_state(settings, blocked):
    return {
        "protocolSupported": True,
        "configured": mail_configured(settings),
        "deliveryAllowed": not blocked,
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


async def discovery_identity_inputs(conn):
    # The public configuration is one ordinary PG snapshot. Actual account
    # insertion still uses the shared transactional registration gate.
    installed = SITE_SETTINGS_MIGRATION in getattr(conn, "_alcor_schema_names", ())
    if not installed:
        installed = await site_settings_installed(conn)
    registration_gate = (
        "(SELECT allow_register FROM public.site_settings WHERE singleton)" if installed else "TRUE"
    )
    inputs = await (
        await conn.execute(
            f"""
            SELECT rp_id, origin, ({REGISTRATION_STATUS_QUERY}) AS first_user,
                   {registration_gate} AS registration_open,
                   EXISTS (
                       SELECT 1 FROM restore_quarantine WHERE category='external_delivery_disabled'
                   ) AS mail_blocked,
                   EXISTS (
                       SELECT 1 FROM restore_quarantine
                       WHERE category='external_delivery_disabled' AND payload->>'disabled'='true'
                   ) AS external_delivery_blocked
            FROM identity_passkey_config WHERE singleton=true
            """
        )
    ).fetchone()
    if inputs is None:
        raise TargetMismatch("Passkey discovery configuration is missing")
    if inputs["first_user"] is None:
        raise TargetMismatch("Registration state is missing")
    if inputs["registration_open"] is None:
        raise HTTPException(503, "站点注册配置缺失")
    return inputs


def native_email_registration_discovery(availability, *, opened, first_user):
    # Existing native clients accept ordinary-user registration receipts only.
    # First-account role assignment stays in the shared PG transaction; the new
    # Web supports that bootstrap rather than mislabelling an admin receipt.
    ready = bool(
        opened and not first_user and availability["configured"] and availability["deliveryAllowed"]
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
            "firstAccountRequiresWeb": first_user,
            "configured": availability["configured"],
            "deliveryAllowed": availability["deliveryAllowed"],
            "deliveryHealth": "not_checked",
        },
    }
