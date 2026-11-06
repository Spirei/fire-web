"""Default-disabled instance wiring into the one existing platform Worker."""

from .notification_bindings import Bindings
from .notification_provider_wire import Origin
from .notification_providers import Providers, ProviderTarget
from .price_alert_service import Alerts


def targets(settings):
    result = []
    for raw in getattr(settings, "business_notification_targets", []):
        value = dict(raw)
        value["origins"] = {name: Origin(**origin) for name, origin in value.get("origins", {}).items()}
        result.append(ProviderTarget(**value))
    return tuple(result)


def from_settings(db, quote_reader=None):
    # A concrete authoritative quote service must be installed, never an old-Web proxy.
    from .market_runtime import reader_from_settings
    service = Alerts(db, quote_reader if quote_reader is not None else reader_from_settings(db))
    if quote_reader is None:
        service.reader_provider = lambda: reader_from_settings(db)
    providers = Providers(db, targets(db.settings), target_provider=lambda: targets(db.settings))
    service.providers, service.bindings = providers, Bindings(service, providers)
    return service


async def discovery(service, version):
    base = f"/api/v{version}/price-alerts"
    async with service.db.connection() as conn:
        from . import __version__

        fingerprint = getattr(service.reader, "fingerprint", None)
        worker = await (
            await conn.execute(
                """SELECT 1 FROM price_alert_worker_heartbeats WHERE observed_at>clock_timestamp()-interval '30 seconds'
            AND origin_instance=%s AND release_version=%s AND source_fingerprint=%s LIMIT 1""",
                (service.db.settings.instance_id, __version__, fingerprint),
            )
        ).fetchone()
        from .fx_reference import external_delivery_blocked

        quarantined = await external_delivery_blocked(conn)
    return {
        "version": 1,
        "snapshot_path": base,
        "operation_path": base + "/operations/{requestId}",
        "read_scope": "portfolio.read",
        "write_scope": "portfolio.write",
        "worker": "server",
        "interval_seconds": 5,
        "idempotency": "query-original-no-replay",
        "channels": ["app", "email", "telegram"],
        "wechat": {"version": 1, "binding": "verification-code"},
        "messengers": {"version": 1, "binding": "verification-code", "channels": ["feishu", "discord", "qq"]},
        "monitoring_available": bool(worker and service.reader is not None and not quarantined),
    }
