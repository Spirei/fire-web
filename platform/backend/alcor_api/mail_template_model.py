"""Plain-text mail template contracts; values never become executable markup."""

import re
from copy import deepcopy

from fastapi import HTTPException

DEFAULTS = [
    {
        "id": "email_change",
        "name": "修改邮箱验证码",
        "kind": "code",
        "subject": "{{siteName}} 修改邮箱验证码",
        "title": "邮箱验证",
        "greeting": "尊敬的客户：",
        "body": "您的邮箱 {{email}} 申请修改绑定邮箱，该验证码 {{minutes}} 分钟内有效，请勿泄露给其他人。",
        "valueLabel": "验证码",
        "closing": "此致",
        "signature": "{{siteName}}",
    },
    {
        "id": "password_reset",
        "name": "找回密码",
        "kind": "code",
        "subject": "{{siteName}} 密码重置验证码",
        "title": "找回密码",
        "greeting": "尊敬的客户：",
        "body": "您的邮箱 {{email}} 申请重置密码，该验证码 {{minutes}} 分钟内有效，请勿泄露给其他人。",
        "valueLabel": "验证码",
        "closing": "此致",
        "signature": "{{siteName}}",
    },
    {
        "id": "email_verification",
        "name": "邮箱验证",
        "kind": "link",
        "subject": "确认您的 {{siteName}} 邮箱",
        "title": "邮箱验证",
        "greeting": "尊敬的客户：",
        "body": "您的邮箱 {{email}} 申请验证，请点击下方链接确认。该链接 {{minutes}} 分钟内有效，请勿转发给其他人。",
        "valueLabel": "验证邮箱",
        "closing": "此致",
        "signature": "{{siteName}}",
    },
    {
        "id": "test",
        "name": "邮件服务测试",
        "kind": "message",
        "subject": "{{siteName}} 邮件服务测试",
        "title": "邮件服务测试",
        "greeting": "尊敬的客户：",
        "body": "邮件服务已连接成功。您的邮箱 {{email}} 可以接收 {{siteName}} 的账户验证邮件。",
        "valueLabel": "连接成功",
        "closing": "此致",
        "signature": "{{siteName}}",
    },
    {
        "id": "registration",
        "name": "邮箱注册验证码",
        "kind": "code",
        "subject": "{{siteName}} 注册验证码",
        "title": "注册账户",
        "greeting": "尊敬的客户：",
        "body": "您的邮箱 {{email}} 申请注册账户，该验证码 {{minutes}} 分钟内有效，请勿泄露给其他人。",
        "valueLabel": "验证码",
        "closing": "此致",
        "signature": "{{siteName}}",
    },
    {
        "id": "price_alert",
        "name": "股价提醒",
        "kind": "message",
        "subject": "{{siteName}} 股价提醒 · {{stockName}}",
        "title": "{{stockName}} 股价提醒",
        "greeting": "尊敬的客户：",
        "body": "{{stockCode}} · {{market}} · 已{{direction}}提醒价",
        "valueLabel": "触发价",
        "closing": "此致",
        "signature": "{{siteName}}",
    },
]
FIELDS = ("subject", "title", "greeting", "body", "valueLabel", "closing", "signature")
COMMON = {"email", "minutes", "name", "siteName"}
PRICE = {
    "stockName",
    "stockCode",
    "market",
    "currentPrice",
    "targetPrice",
    "currency",
    "direction",
    "session",
    "quoteTime",
    "triggerTime",
}
JS_TRIM = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def validate(raw):
    preset = next((v for v in DEFAULTS if isinstance(raw, dict) and v["id"] == raw.get("id")), None)
    if preset is None or set(raw) - {"id", "name", "kind", *FIELDS}:
        raise HTTPException(422, "模板字段无效")
    result = deepcopy(preset)
    for key in FIELDS:
        value = raw.get(key)
        if (
            not isinstance(value, str)
            or (key != "signature" and not value.strip(JS_TRIM))
            or len(value.encode("utf-16-le", "surrogatepass")) // 2 > (1600 if key == "body" else 160)
            or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value)
        ):
            raise HTTPException(422, "请填写完整模板，正文最多1600字，其他字段最多160字")
        allowed = COMMON | (PRICE if preset["id"] == "price_alert" else set())
        if any(v not in allowed for v in re.findall(r"\{\{([^{}]+)\}\}", value)):
            raise HTTPException(422, "模板包含不支持的变量")
        result[key] = value.strip(JS_TRIM)
    return result


def render_text(template, values):
    allowed = COMMON | (PRICE if template["id"] == "price_alert" else set())

    def fill(text):
        return re.sub(
            r"\{\{([A-Za-z][A-Za-z0-9]*)\}\}",
            lambda m: str(values.get(m[1], "")) if m[1] in allowed else m[0],
            text,
        )

    if template["kind"] == "code" and not re.fullmatch(r"[0-9]{6}", str(values.get("code", ""))):
        raise HTTPException(422, "验证码格式无效")
    if template["kind"] == "link":
        from urllib.parse import urlsplit

        url = urlsplit(values.get("url", ""))
        if url.scheme not in {"https", "http"} or not url.hostname or url.username or url.password:
            raise HTTPException(422, "验证链接无效")
    if template["id"] == "price_alert":
        fields = [
            fill(template["title"]),
            fill(template["body"]),
            fill(template["valueLabel"])
            + " "
            + (values.get("currentPrice") or "—")
            + " "
            + values.get("currency", ""),
            "提醒价 " + (values.get("targetPrice") or "—"),
            " · ".join(filter(None, (values.get("session"), values.get("triggerTime")))),
            fill(template["signature"]),
        ]
    else:
        fields = [
            fill(template["title"]),
            fill(template["greeting"]),
            fill(template["body"]),
            fill(template["valueLabel"]),
            values.get("code") or values.get("url") or "",
            "Alcor App 一次性凭证：" + values["nativeToken"] if values.get("nativeToken") else "",
            fill(template["closing"]),
            fill(template["signature"]),
        ]
    return {
        "subject": re.sub(r"[\r\n]", " ", fill(template["subject"])),
        "text": "\n\n".join(v for v in fields if v),
    }
