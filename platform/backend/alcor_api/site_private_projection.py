"""Reviewed non-secret legacy settings views over existing platform authorities."""

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException

from .site_settings import domain


def mail_metadata(runtime, configured):
    fields = {}
    source = {
        "state": "unconfigured",
        "authority": "runtime_identity_mail",
        "legacyCoverage": "unknown",
        "deliveryHealth": "not_checked",
    }
    if runtime.mail_host:
        fields.update(
            smtpHost=runtime.mail_host,
            smtpPort=str(runtime.mail_port),
            smtpSecure=runtime.mail_tls == "tls",
            smtpFromEmail=runtime.mail_sender,
            smtpPasswordConfigured=bool(runtime.mail_password),
        )
        source.update(
            state="enabled" if configured else "disabled",
            usernameState="sealed_present" if runtime.mail_username else "not_set",
        )
    # This is the existing email challenge binding, never the editable brand domain.
    # A local runtime address must not be repackaged as a public legacy link origin.
    try:
        if (
            not runtime.public_origin.lower().startswith("https://")
            or runtime.public_origin != runtime.public_origin.strip()
        ):
            raise HTTPException(400, "链接来源不可公开")
        origin = domain(runtime.public_origin)
    except HTTPException:
        source["linkOriginState"] = "not_public_omitted"
    else:
        if origin:
            fields["emailLinkOrigin"] = runtime.public_origin
            source["linkOriginState"] = "runtime_binding"
        else:
            source["linkOriginState"] = "unconfigured"
    return fields, source


def fx_schedule_metadata(row):
    if not row:
        raise HTTPException(503, "汇率配置缺失")
    source = {
        "authority": "fx_config_and_immutable_provider_revision",
        "revision": row["revision"],
        "enabled": row["enabled"],
        "executionHealth": "not_checked",
        "urlState": "sealed_not_projected",
    }
    if not row["provider_revision"]:
        return {}, {**source, "state": "builtin_no_legacy_pattern"}
    source["providerRevision"] = str(row["provider_revision"])
    config = row["config"]
    if not isinstance(config, dict):
        raise HTTPException(503, "汇率供应商配置缺失")
    schedule = config.get("schedule")
    if schedule is None:
        return {}, {**source, "state": "custom_no_schedule"}
    if not isinstance(schedule, dict):
        raise HTTPException(503, "汇率计划配置无效")
    pattern, timezone = schedule.get("pattern"), schedule.get("timezone")
    if not isinstance(pattern, str) or len(pattern) > 200 or not isinstance(timezone, str):
        raise HTTPException(503, "汇率计划配置无效")
    try:
        ZoneInfo(timezone)
    except (ValueError, ZoneInfoNotFoundError):
        raise HTTPException(503, "汇率计划时区无效") from None
    return {"currencyRefreshPattern": pattern}, {
        **source,
        "state": "saved_schedule",
        "timezone": timezone,
        "interpretation": "platform_saved_slots_in_explicit_timezone",
    }
