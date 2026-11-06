"""Owner-scoped committed change watermarks, never a financial-data authority."""

import hashlib
import json

from fastapi import HTTPException

from .identity_devices import milliseconds, web_device_id
from .native_app_auth import CLIENT, authenticate

# Last shipped definition: 0045_account_signals.sql. A deliberate later
# function change must update this frozen source proof and its counterexample.
CAPTURE_FUNCTION_SHA256 = "6ba3f860979a2da59385521a9e2dc8e515a5a7726a77d426c03cee150c5b7728"

DOMAINS = (
    "profile",
    "portfolio",
    "watch",
    "brokers",
    "alerts",
    "resources",
    "feed",
    "settings",
    "authorization",
)
DOMAIN_SCOPES = {
    "profile": "portfolio.read",
    "portfolio": "portfolio.read",
    "watch": "portfolio.read",
    "brokers": "portfolio.read",
    "alerts": "portfolio.read",
    "resources": "resources.read",
    "feed": "feed.read",
    "settings": "portfolio.read",
    "authorization": "security.read",
}


# Required authority commits remain explicit even if a registry row is missing.
EXPECTED_SOURCES = {
    "profile": [("users", "id", "username,email,uid,is_test", ""), ("user_profiles", "user_id", "", "")],
    "portfolio": [
        ("portfolio_records", "owner_id", "", ""),
        ("trade_ledger", "owner_id", "", ""),
        ("cash_ledger_accounts", "owner_id", "", ""),
        ("cash_ledger_entries", "owner_id", "", ""),
        ("internal_orders", "owner_id", "", ""),
        ("trade_amendments", "owner_id", "", ""),
        ("trade_fee_projections", "owner_id", "", ""),
        ("trade_fee_corrections", "owner_id", "", ""),
        ("actual_fee_confirmations", "owner_id", "", ""),
        ("native_actual_fee_confirmations", "owner_id", "", ""),
        ("broker_statement_imports", "owner_id", "", ""),
        ("broker_statement_positions", "owner_id", "", ""),
        ("broker_position_transfers", "owner_id", "", ""),
        ("broker_position_transfer_events", "owner_id", "", ""),
        ("fund_sources", "owner_id", "", ""),
        ("fund_source_retirements", "owner_id", "", ""),
        ("asset_instrument_heads", "owner_id", "", ""),
        ("internal_order_contexts", "owner_id", "", ""),
        ("legacy_flat_order_operations", "owner_id", "", ""),
        ("internal_order_family_legs", "owner_id", "", ""),
        ("card_wallet_collections", "owner_id", "", ""),
    ],
    "watch": [
        ("watch_groups", "owner_id", "", ""),
        ("watch_display_fields", "owner_id", "", ""),
        ("portfolio_record_orderings", "owner_id", "", ""),
        ("watch_group_icon_versions", "owner_id", "", ""),
        ("watch_group_source_bindings", "owner_id", "", ""),
    ],
    "brokers": [
        ("broker_accounts", "owner_id", "", ""),
        ("broker_statement_sources", "owner_id", "", ""),
        ("broker_icon_versions", "owner_id", "", ""),
    ],
    "alerts": [
        ("price_alert_rules", "owner_id", "", ""),
        ("price_alert_collections", "owner_id", "", ""),
        ("business_notification_events", "owner_id", "", ""),
        ("business_notification_reads", "owner_id", "", ""),
        ("business_notification_bindings", "owner_id", "", ""),
        ("business_notification_provider_revisions", "owner_id", "", ""),
        ("business_notification_provider_revocations", "owner_id", "", ""),
        ("business_notification_provider_checks", "owner_id", "", ""),
        ("business_notification_challenges", "owner_id", "", ""),
        ("business_notification_deliveries", "owner_id", "", ""),
    ],
    "resources": [("resource_files", "owner_id", "", ""), ("resource_folders", "owner_id", "", "")],
    "feed": [
        ("feed_groups", "owner_id", "", ""),
        ("feed_posts", "owner_id", "", ""),
        ("feed_group_preferences", "owner_id", "", ""),
        ("feed_agent_profiles", "owner_id", "", ""),
    ],
    "settings": [
        ("account_preferences", "user_id", "", ""),
        ("fire_planning_settings", "owner_id", "value", ""),
        ("fee_plan_heads", "owner_id", "", ""),
        ("fee_plan_revisions", "owner_id", "", ""),
        ("card_preference_collections", "owner_id", "", ""),
        ("card_custom_records", "owner_id", "", ""),
        ("card_wallet_details", "owner_id", "", ""),
        ("registered_fee_baseline_heads", "owner_id", "", ""),
        ("legacy_fee_estimation_heads", "owner_id", "", ""),
        ("fee_legacy_inventory_heads", "owner_id", "", ""),
        ("fee_legacy_attributions", "owner_id", "", ""),
        ("fee_state_fields", "owner_id", "", ""),
        ("private_runtime_versions", "actor_id", "", ""),
    ],
    "authorization": [
        ("legacy_source_grants", "owner_id", "", ""),
        ("market_source_configs", "owner_id", "", ""),
        ("market_source_revocations", "owner_id", "", ""),
        ("users", "id", "role,active,session_version,password_hash", ""),
        ("sessions", "user_id", "", ""),
        ("identity_app_grants", "user_id", "", "last_used_at"),
        ("identity_app_consents", "user_id", "", ""),
        ("client_grants", "owner_id", "", "last_used_at"),
        ("identity_passkeys", "user_id", "id,rp_id,public_key,user_handle", ""),
        (
            "identity_security",
            "user_id",
            "totp_enabled,totp_secret_ciphertext,backup_codes,email_verified,source_stamp",
            "",
        ),
    ],
}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


async def guard(conn, who, required_scope=None):
    """Revalidate within the read transaction; hold the same owner before session/grant locks."""
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
    )
    user = await (await conn.execute("SELECT * FROM users WHERE id=%s FOR SHARE", (who.id,))).fetchone()
    if not user or not user["active"]:
        raise HTTPException(401, "账号已失效")
    if user["role"] != who.role:
        raise HTTPException(403, "账号权限已变化，请重新读取当前账号")
    if getattr(who, "native_client", False):
        await conn.execute("SELECT id FROM identity_app_grants WHERE id=%s FOR SHARE", (who.grant_id,))
        grant = await authenticate(conn, who.native_access_token, required_scope or "portfolio.read")
        if grant["id"] != who.grant_id or grant["user_id"] != who.id or grant["client_id"] != CLIENT:
            raise HTTPException(401, "客户端连接已变化")
        principal, scopes = grant["id"], sorted(grant["scope"].split())
        device = {
            "id": grant["id"],
            "kind": "app",
            "name": grant["device_name"],
            "createdAt": milliseconds(grant["created_at"]),
            "expiresAt": milliseconds(grant["expires_at"]),
            "lastUsedAt": milliseconds(grant["last_used_at"]),
            "lastUsedEvidence": "grant_created_or_renewed",
        }
    else:
        row = await (
            await conn.execute(
                "SELECT * FROM sessions WHERE token_hash=%s AND user_id=%s AND client_id='new-web' "
                "AND session_version=%s AND expires_at>clock_timestamp() FOR SHARE",
                (who.token_hash, who.id, user["session_version"]),
            )
        ).fetchone()
        if not row:
            raise HTTPException(401, "会话已失效")
        if (
            row["passkey_id"]
            and not await (
                await conn.execute(
                    "SELECT 1 FROM identity_passkeys WHERE id=%s AND user_id=%s", (row["passkey_id"], who.id)
                )
            ).fetchone()
        ):
            raise HTTPException(401, "会话凭据已撤销")
        principal, scopes = web_device_id(who.token_hash), ["new-web-owner"]
        device = {
            "id": principal,
            "kind": "web",
            "name": "网页登录",
            "createdAt": milliseconds(row["created_at"]),
            "expiresAt": milliseconds(row["expires_at"]),
            "lastUsedAt": None,
            "lastUsedEvidence": "unavailable",
        }
    instance = await (await conn.execute("SELECT instance_id FROM alcor_instance WHERE singleton")).fetchone()
    scope = {
        "instanceId": str(instance["instance_id"]),
        "userId": user["id"],
        "role": user["role"],
        "principal": principal,
        "scopes": scopes,
        "sessionVersion": user["session_version"],
        "apiVersion": 1,
    }
    return (
        scope,
        fingerprint(scope),
        {
            **device,
            "authorizationState": "active",
            "onlineState": "unknown",
            "current": True,
        },
    )


class AccountSignals:
    def __init__(self, db):
        self.db = db

    async def read(self, who, expected_context=None, *, devices=False, legacy_watermarks=False):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            scope, context, device = await guard(conn, who)
            if expected_context is not None and expected_context != context:
                raise HTTPException(403, "读取身份或实例已变化，请撤下旧内容")
            metadata = await (
                await conn.execute("SELECT epoch,installed_at FROM account_change_metadata WHERE singleton")
            ).fetchone()
            if metadata is None:
                raise HTTPException(503, "同步变更代次尚未安装，读取不会初始化")
            observed = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
            result = {
                "version": 1,
                "userId": who.id,
                "instanceId": scope["instanceId"],
                "context": context,
                "epoch": str(metadata["epoch"]),
                "scope": "platform_since_install",
                "installedAt": metadata["installed_at"].isoformat(),
                "observedAt": observed.isoformat(),
                "binding": scope,
                "financialAuthority": False,
                "legacyComplete": False,
                "revisionMeaning": "committed_row_change_watermark_not_commit_count",
                "unrepresentedSources": ["shared_card_catalog", "legacy_card_source_bindings"],
                "sourceCoverageIsMigrationCompleteness": False,
            }
            if devices:
                return {**result, "device": device}
            rows = await (
                await conn.execute(
                    "SELECT domain,revision,changed_at FROM account_change_revisions WHERE owner_id=%s",
                    (who.id,),
                )
            ).fetchall()
            by_domain = {row["domain"]: row for row in rows}
            capture_verified = (await (await conn.execute("""SELECT EXISTS(
                SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.capture_account_change()')
                AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=%s
                AND p.prorettype='trigger'::regtype AND p.pronargs=0
                AND NOT p.prosecdef AND NOT p.proisstrict AND p.provolatile='v' AND p.proconfig IS NULL
                AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')) AS verified""",
                (CAPTURE_FUNCTION_SHA256,))).fetchone())["verified"]
            registrations = await (
                await conn.execute(
                    """SELECT s.*,EXISTS(SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid=to_regclass('public.'||s.source_table)
                AND t.tgname=CASE WHEN s.domain='settings' AND s.source_table='private_runtime_versions'
                  THEN 'account_signal_private_runtime' ELSE 'account_signal_'||s.domain END
                AND NOT t.tgisinternal
                AND t.tgenabled IN ('O','A') AND t.tgtype=29 AND t.tgqual IS NULL
                AND t.tgfoid=to_regprocedure('public.capture_account_change()') AND %s
                AND t.tgargs=convert_to(s.domain,'UTF8')||decode('00','hex')||
                  convert_to(s.owner_column,'UTF8')||decode('00','hex')||
                  convert_to(s.selected_columns,'UTF8')||decode('00','hex')||
                  convert_to(s.ignored_columns,'UTF8')||decode('00','hex')) AS installed
                FROM account_change_sources s ORDER BY s.domain,s.source_table""",
                    (capture_verified,),
                )
            ).fetchall()
            domains = {}
            for domain in DOMAINS:
                # The original App sync permission grants only these owner's
                # opaque change cursors, never the contents of another domain.
                authorized = legacy_watermarks or "new-web-owner" in scope["scopes"] or DOMAIN_SCOPES[domain] in scope["scopes"]
                sources = [row for row in registrations if row["domain"] == domain]
                registered = {row["source_table"]: row for row in sources}
                required = {
                    name: (owner, selected, ignored)
                    for name, owner, selected, ignored in EXPECTED_SOURCES[domain]
                }
                missing = []
                installed = []
                covered_since = [metadata["installed_at"]]
                for name in sorted(set(required) | set(registered)):
                    source = registered.get(name)
                    matches = bool(
                        source
                        and source["installed"]
                        and (
                            name not in required
                            or (source["owner_column"], source["selected_columns"], source["ignored_columns"])
                            == required[name]
                        )
                    )
                    (installed if matches else missing).append(name)
                    if matches and source.get("covered_since"):
                        covered_since.append(source["covered_since"])
                row = by_domain.get(domain)
                state = (
                    "forbidden"
                    if not authorized
                    else "partial"
                    if not capture_verified and sources
                    else "unavailable"
                    if not installed
                    else "partial"
                    if missing
                    else "observed"
                )
                domains[domain] = {
                    "state": state,
                    "revision": (row["revision"] if row else 0) if authorized and installed else None,
                    "lastChangedAt": row["changed_at"].isoformat() if row and authorized else None,
                    "sources": installed if authorized else [],
                    "missingSources": missing if authorized else [],
                    "coveredSince": max(covered_since).isoformat() if authorized and installed else None,
                    "expectedSources": sorted(required) if authorized else [],
                    "commitSignalComplete": bool(authorized and installed and not missing),
                    "historicalDataCoverageKnown": False,
                }
            return {
                **result,
                "domains": domains,
                "revisions": {key: value["revision"] for key, value in domains.items()},
            }
