"""PG public settings; no provider addresses, secrets, local paths or inferred branding."""

import hashlib
import ipaddress
import json
import re
from urllib.parse import urlsplit
from uuid import UUID

import idna
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .security import lock_mutation_identity
from .site_registration import installed
from .site_settings_layout import DEFAULTS as LAYOUT_DEFAULTS

DEFAULTS = {
    "title": "Alcor",
    "ico": None,
    "pwaIcon": None,
    "homepageBg": None,
    "loginSideImage": None,
    "domain": "",
    "siteLogo": None,
    "logoText": "Alcor",
    "logoFont": "system",
    "footerDesc": "",
    "homeNav": [],
    "mobileNavigationOrder": [],
    "marketBadges": {},
    "marketBadgesVisible": True,
}
ASSETS = {"appDisplayIcon":"ico","pwaIcon": "ico", "ico": "ico", "homepageBg": "background", "loginSideImage": "login", "siteLogo": "logo"}
MARKETS = {
    "US",
    "HK",
    "SH",
    "CN",
    "ASSET",
    "SZ",
    "CRYPTO",
    "JP",
    "KR",
    "SG",
    "TW",
    "UK",
    "DE",
    "FR",
    "AU",
    "CA",
    "IN",
    "BR",
    "OTHER",
}


def text(value, maximum, label):
    if not isinstance(value, str) or len(value) > maximum or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise HTTPException(400, label + "格式无效")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise HTTPException(400, label + "格式无效") from None
    return value.strip()


def domain(value):
    value = text(value, 255, "公开域名")
    if not value:
        return ""
    try:
        parsed = urlsplit(value if "://" in value else "https://" + value)
        host = idna.encode(parsed.hostname or "", uts46=True).decode().lower()
        port = parsed.port
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or "." not in host
            or re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|[0-9]+)", host.rstrip(".").split(".")[-1])
            or any(
                host.rstrip(".") == suffix or host.rstrip(".").endswith("." + suffix)
                for suffix in ("local", "localhost", "lan", "internal")
            )
        ):
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError()
        if port is not None and not 1 <= port <= 65535:
            raise ValueError()
        return "https://" + host + (":" + str(port) if port not in (None, 443) else "")
    except (ValueError, UnicodeError, idna.IDNAError):
        raise HTTPException(400, "公开域名须为不含凭据、路径或参数的公网 HTTPS 域名") from None


def normalize(patch):
    if not isinstance(patch, dict) or not patch or set(patch) - (set(DEFAULTS) | set(LAYOUT_DEFAULTS) | {"allowRegister"}):
        raise HTTPException(400, "仅允许已登记的公开站点字段")
    result = {}
    for key, value in patch.items():
        if key in ASSETS:
            if value in (None, ""):
                result[key] = None
            else:
                try:
                    result[key] = str(UUID(value))
                except (ValueError, TypeError, AttributeError):
                    raise HTTPException(400, "素材须选择已登记版本") from None
        elif key in LAYOUT_DEFAULTS:
            from .site_settings_layout import normalize as layout
            result[key]=layout(key,value)
        elif key in {"allowRegister", "marketBadgesVisible"}:
            if type(value) is not bool:
                raise HTTPException(400, "开关须为明确布尔值")
            result[key] = value
        elif key == "domain":
            result[key] = domain(value)
        elif key == "logoFont":
            if value not in {"diatype", "diatype-regular", "system"}:
                raise HTTPException(400, "字体无效")
            result[key] = value
        elif key == "mobileNavigationOrder":
            if (not isinstance(value,list) or len(value)>100 or
                any(not isinstance(item,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}",item) for item in value) or
                len(set(value))!=len(value)):
                raise HTTPException(400,"手机导航顺序无效")
            result[key]=list(value)
        elif key == "homeNav":
            if not isinstance(value, list) or len(value) > 20:
                raise HTTPException(400, "导航格式无效")
            rows, seen = [], set()
            for item in value:
                if (
                    not isinstance(item, dict)
                    or set(item) != {"key", "label", "href", "enabled"}
                    or type(item["enabled"]) is not bool
                ):
                    raise HTTPException(400, "导航格式无效")
                ident, label, href = (
                    text(item["key"], 40, "导航键"),
                    text(item["label"], 80, "导航名称"),
                    text(item["href"], 512, "导航地址"),
                )
                if (
                    not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", ident)
                    or ident in seen
                    or not href.startswith(("/", "#"))
                    or href.startswith("//")
                    or "\\" in href
                ):
                    raise HTTPException(400, "导航地址只支持站内路径或锚点")
                seen.add(ident)
                rows.append({"key": ident, "label": label, "href": href, "enabled": item["enabled"]})
            result[key] = rows
        elif key == "marketBadges":
            if not isinstance(value, dict) or set(value) - MARKETS:
                raise HTTPException(400, "市场色块格式无效")
            badges = {}
            for market, item in value.items():
                if not isinstance(item, dict) or set(item) != {"label", "bg", "fg"}:
                    raise HTTPException(400, "市场色块格式无效")
                row = {"label": text(item["label"], 4, "色块名称")}
                for color in ("bg", "fg"):
                    raw = text(item[color], 7, "色块颜色").lower()
                    if re.fullmatch(r"#[a-f0-9]{3}", raw):
                        raw = "#" + "".join(c * 2 for c in raw[1:])
                    if not re.fullmatch(r"#[a-f0-9]{6}", raw):
                        raise HTTPException(400, "颜色须为十六进制色值")
                    row[color] = raw
                badges[market] = row
            result[key] = badges
        else:
            result[key] = text(value, 500 if key == "footerDesc" else 120, "公开文字")
    return result


async def public_projection(conn, row, mail_configured):
    # Keep the public browser contract an explicit allowlist even if a restored
    # or future settings record contains additional private configuration.
    values = row["settings"] if row else {}
    stored = {key: values.get(key, default) for key, default in DEFAULTS.items()}
    for key, kind in ASSETS.items():
        if key not in stored:continue
        identifier = stored[key]
        if identifier:
            asset = await (
                await conn.execute(
                    "SELECT public_path,served_sha256 FROM system_asset_versions WHERE id=%s AND kind=%s",
                    (identifier, kind),
                )
            ).fetchone()
            if not asset:
                raise HTTPException(503, "登记素材版本不可用")
            stored[key] = asset["public_path"] + "?sha256=" + asset["served_sha256"]
        else:
            stored[key] = ""
    quarantined = await (
        await conn.execute("SELECT 1 FROM restore_quarantine WHERE category='external_delivery_disabled'")
    ).fetchone()
    return {
        # The standalone PWA icon uses its versioned image route; old public JSON stays exact.
        **{key:value for key,value in stored.items() if key != "pwaIcon"},
        "allowRegister": row["allow_register"] if row else True,
        "emailRegistration": bool(
            mail_configured and not quarantined and (row["allow_register"] if row else True)
        ),
    }


class SiteSettings:
    def __init__(self, db, mail):
        self.db, self.mail = db, mail

    async def public(self):
        async with self.db.connection() as conn, conn.transaction():
            ready = await installed(conn)
            row = (
                await (await conn.execute("SELECT * FROM site_settings WHERE singleton")).fetchone()
                if ready
                else None
            )
            if ready and not row:
                raise HTTPException(503, "站点配置缺失")
            return await public_projection(conn, row, self.mail.configured)

    async def authorize(self, conn, who):
        # Same global/account order as admin role changes; registration owns
        # users before the site row, and never waits for an account advisory lock.
        await conn.execute("SELECT pg_advisory_xact_lock(67132005)")
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who)

    async def read(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            row = await (await conn.execute("SELECT * FROM site_settings WHERE singleton")).fetchone()
            if not row:
                raise HTTPException(503, "站点配置缺失")
            return {
                "revision": row["revision"],
                "settings": {**LAYOUT_DEFAULTS, **DEFAULTS, **row["settings"], "allowRegister": row["allow_register"]},
                "public": await public_projection(conn, row, self.mail.configured),
            }

    async def save(self, who, request_id, revision, patch, password, code, verifier):
        patch = normalize(patch)
        fingerprint = hashlib.sha256(
            json.dumps(
                {"revision": revision, "patch": patch},
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
            ).encode()
        ).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            old = await (
                await conn.execute(
                    "SELECT * FROM site_settings_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if old:
                if old["closed"] or old["fingerprint"] != fingerprint:
                    raise HTTPException(409, "原请求已关闭或用于其他修改，请查询原回执")
                return old["result"]
            await verifier.step_up(conn, who, password, code)
            await conn.execute(
                "SELECT pg_advisory_xact_lock_shared(hashtextextended('system-public-assets',0))"
            )
            row = await (
                await conn.execute("SELECT * FROM site_settings WHERE singleton FOR UPDATE")
            ).fetchone()
            if not row or row["revision"] != revision:
                raise HTTPException(409, "站点配置已变化，请重新读取")
            if row["revision"] >= 9007199254740991:
                raise HTTPException(409, "站点配置修订已到上限")
            for key, kind in ASSETS.items():
                if (
                    patch.get(key)
                    and not await (
                        await conn.execute(
                            "SELECT 1 FROM system_asset_versions WHERE id=%s AND kind=%s", (patch[key], kind)
                        )
                    ).fetchone()
                ):
                    raise HTTPException(400, "素材须选择对应分类的已登记版本")
            settings = {
                **row["settings"],
                **{key: value for key, value in patch.items() if key != "allowRegister"},
            }
            updated = await (
                await conn.execute(
                    "UPDATE site_settings SET settings=%s,allow_register=%s,revision=revision+1 WHERE singleton RETURNING *",
                    (Jsonb(settings), patch.get("allowRegister", row["allow_register"])),
                )
            ).fetchone()
            result = {
                "requestId": str(request_id),
                "state": "completed",
                "revision": updated["revision"],
                "settings": {**LAYOUT_DEFAULTS, **DEFAULTS, **updated["settings"], "allowRegister": updated["allow_register"]},
            }
            await conn.execute(
                "INSERT INTO site_settings_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, request_id, fingerprint, Jsonb(result)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'site.settings.updated',%s)",
                (who.id, request_id),
            )
            return result

    async def receipt(self, who, request_id):
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            old = await (
                await conn.execute(
                    "SELECT result FROM site_settings_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if not old:
                raise HTTPException(404, "未找到原站点配置请求")
            return old["result"]

    async def close(self, who, request_id):
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            old = await (
                await conn.execute(
                    "SELECT result FROM site_settings_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if old:
                return old["result"]
            result = {"requestId": str(request_id), "state": "closed", "executed": False}
            await conn.execute(
                "INSERT INTO site_settings_operations(owner_id,request_id,fingerprint,result,closed) VALUES(%s,%s,%s,%s,true)",
                (who.id, request_id, "0" * 64, Jsonb(result)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'site.settings.closed',%s)",
                (who.id, request_id),
            )
            return result
