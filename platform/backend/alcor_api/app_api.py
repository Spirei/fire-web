"""Stable App paths over the existing native API handlers and wire contract."""

APP_PREFIX = "/api/app"
VERSIONED_PREFIX = "/api/v2"
VERSION_TEMPLATE = "/api/v{version}"
NATIVE_FAMILIES = frozenset({
    "account-assets", "account-sync", "app-state", "assets", "broker-accounts",
    "brokers", "celebs", "chart-series", "charts", "company-profile", "earnings",
    "feed", "funds", "hk-board-lot", "index-kline", "indices",
    "investment-files", "kline", "kline-sessions", "market-calendar", "market-ranking",
    "market-source-tests", "orders", "overview", "personal-profile", "portfolio-series",
    "price-alerts", "quote-subscriptions", "quotes", "rates", "records",
    "resource-library", "search", "simple-ledger", "social-channels", "stock-detail",
    "upload", "watch-groups",
})
AUTH_FAMILIES = frozenset({
    "avatar", "config", "consent", "email", "email-change", "email-verification",
    "login", "me", "passkeys", "password", "password-change", "password-reset",
    "permissions", "profile", "revoke", "security-devices", "token", "totp",
})
FIXED_TARGETS = {
    "/auth/authorize": "/api/v1/auth/authorize",
    "/auth/register": "/api/auth/register",
    "/auth/register/email/request": "/api/auth/register/email/request",
    "/auth/register/email/confirm": "/api/auth/register/email/confirm",
}
RAW_READ_TARGETS = {
    "/market/sources": "/api/market/sources",
    "/market/history": "/api/market/history",
    "/portfolio/series": "/api/portfolio/series",
}


def native_family(suffix):
    parts = suffix.removeprefix("/").split("/")
    root = parts[0]
    if root == "auth":
        return root if len(parts) > 1 and parts[1] in AUTH_FAMILIES else None
    if root == "settings":
        return root if suffix == "/settings/public" else None
    return root if root in NATIVE_FAMILIES else None


def app_discovery(value):
    """Publish stable paths while keeping the DTO fields installed Apps understand."""
    fixed_paths = {target: APP_PREFIX + suffix for suffix, target in FIXED_TARGETS.items()}

    def project(item):
        if isinstance(item, dict):
            return {key: project(part) for key, part in item.items()}
        if isinstance(item, list):
            return [project(part) for part in item]
        if isinstance(item, str):
            if item in fixed_paths:
                return fixed_paths[item]
            if item.startswith(VERSIONED_PREFIX + "/"):
                suffix = item.removeprefix(VERSIONED_PREFIX)
                if native_family(suffix):
                    return APP_PREFIX + suffix
        return item

    return {**project(value), "app_api_base_path": APP_PREFIX}


def app_route_patterns(routes):
    patterns = {}
    for route in routes:
        path = getattr(route, "path", "")
        for prefix in (VERSIONED_PREFIX, VERSION_TEMPLATE):
            if path.startswith(prefix + "/"):
                family = native_family(path.removeprefix(prefix))
                if family:
                    patterns.setdefault(family, []).append(route.path_regex)
                break
    return patterns


class AppAPIRouting:
    """Translate only reviewed paths into the same ASGI route before body and auth checks."""

    def __init__(self, app, *, patterns):
        self.app = app
        self.patterns = patterns

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith(APP_PREFIX + "/"):
            return await self.app(scope, receive, send)

        suffix = path.removeprefix(APP_PREFIX)
        target = FIXED_TARGETS.get(suffix)
        if scope["method"] == "GET" and suffix in RAW_READ_TARGETS:
            target = RAW_READ_TARGETS[suffix]
        if target is None:
            candidate = VERSIONED_PREFIX + suffix
            if not any(
                pattern.fullmatch(candidate)
                for pattern in self.patterns.get(native_family(suffix), ())
            ):
                return await self.app(scope, receive, send)
            target = candidate

        state = {**scope.get("state", {}), "stable_app_api": True}
        headers = scope["headers"]
        if suffix != "/auth/authorize":
            # The App API uses Bearer authorization. The system browser PKCE
            # submission is the only route here that consumes a Web session.
            headers = [(key, value) for key, value in headers if key not in (b"cookie", b"x-csrf-token")]
        rewritten = {**scope, "path": target, "headers": headers, "state": state}
        # No handler needs the pre-routing raw path. Let the ASGI URI builder
        # derive it from the same decoded path used for router matching.
        rewritten.pop("raw_path", None)
        return await self.app(rewritten, receive, send)
