"""Explicit one-hour synthetic test authorization; never a runtime default."""

from datetime import UTC, datetime, timedelta

from alcor_api.source_window import MigrationWindow


def active_window():
    now = datetime.now(UTC)
    return MigrationWindow(now - timedelta(minutes=1), now + timedelta(hours=1), "active")
