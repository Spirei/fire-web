"""Non-secret owner descriptors: isolated objects, never PG or real source IO."""

import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from alcor_api.market_authority import Authority, Policy
from alcor_api.market_source_descriptors import describe_sources, public_policy
from fastapi import HTTPException


def policy(owner="owner", identifier="licensed"):
    return Policy(
        identifier,
        "futu",
        "futu-sdk-records-v1",
        "private-target-id",
        "private-target-fingerprint",
        owner,
        "approved-license",
        ("latest", "bars.day", "bars.month"),
        ("US", "JP"),
    )


def test_only_explicit_non_secret_fields_and_installed_history_markets_are_exposed():
    value = public_policy(policy())
    assert set(value) == {
        "id",
        "source",
        "sourceVersion",
        "licenseRevision",
        "purposes",
        "markets",
        "historyMarkets",
        "historyFrames",
        "historyMinuteSessions",
        "latestSupported",
        "latestMarkets",
        "latestInstruments",
        "latestCapabilities",
        "timestampZones",
        "latestSessions",
        "latestTimestampAuthority",
        "latestCacheAuthority",
        "latestSymbols",
        "latestSessionAuthority",
        "historyKinds",
        "historyCapabilities",
        "historySymbols",
        "historySymbolSelection",
        "sourceSymbolMappings",
        "historyInstruments",
        "historyAdjustments",
        "priceSeriesSessions",
        "priceSeriesAuthority",
        "priceSeriesHistoricalBackfill",
        "priceSeriesSubscriptions",
    }
    assert value["historyFrames"] == ["day", "month"] and value["historyMarkets"] == ["US"]
    assert value["historyMinuteSessions"] == []
    assert value["timestampZones"] == []
    assert "private-target" not in json.dumps(value)


@pytest.mark.parametrize("zones,expected", [((), []), ((("US", "America/New_York"),), [{"market": "US", "timezone": "America/New_York"}])])
def test_timestamp_zone_descriptor_preserves_only_explicit_tencent_configuration(zones, expected):
    from dataclasses import replace

    installed = replace(policy(), source="tencent", source_version="tencent-quotes-v1", timestamp_zones=zones)
    assert public_policy(installed)["timestampZones"] == expected
    assert public_policy(replace(policy(), timestamp_zones=zones))["timestampZones"] == []
    assert "private-target" not in json.dumps(public_policy(installed))


async def test_descriptor_rechecks_owner_and_returns_no_peer_or_target_configuration(monkeypatch):
    from alcor_api import security

    version = uuid4()
    current = {"role": "user"}
    calls = []

    class Cursor:
        def __init__(self, value):
            self.value = value

        async def fetchone(self):
            return self.value

        async def fetchall(self):
            return self.value

    class DB:
        settings = SimpleNamespace(environment="test")

        @asynccontextmanager
        async def connection(self):
            yield self

        @asynccontextmanager
        async def transaction(self):
            yield self

        async def execute(self, sql, args=None):
            assert sql.startswith(("SELECT", "SET"))
            calls.append(sql)
            if "SELECT role" in sql:
                return Cursor(current)
            if "market_source_configs" in sql:
                assert args == ("owner",)
                return Cursor(
                    [
                        {
                            "revision": version,
                            "policy_id": "licensed",
                            "created_at": datetime(2026, 10, 1, tzinfo=UTC),
                            "revoked": False,
                        }
                    ]
                )
            return Cursor(None)

    authority = Authority(DB(), (policy(), policy("peer", "peer-license")))

    async def config(conn, owner, revision):
        assert owner == "owner" and revision == version
        return {}, policy()

    authority.config = config

    async def lock(conn, who, *, require_admin):
        assert who.id == "owner" and require_admin is False

    monkeypatch.setattr(security, "lock_mutation_identity", lock)
    who = SimpleNamespace(id="owner", role="user")
    result = await describe_sources(authority, who)
    assert result["automaticCollection"] is False
    assert [row["id"] for row in result["policies"]] == ["licensed"]
    assert result["versions"][0]["usable"] is True
    assert "peer-license" not in json.dumps(result) and "private-target" not in json.dumps(result)
    current["role"] = "admin"
    with pytest.raises(HTTPException) as exc:
        await describe_sources(authority, who)
    assert exc.value.status_code == 403


def test_minute_sessions_require_exact_purpose_and_all_requires_us_market():
    from dataclasses import replace
    current = policy()
    value = public_policy(replace(current, purposes=("bars.minute.REGULAR",), markets=("HK",)))
    assert value["historyFrames"] == ["minute"] and value["historyMinuteSessions"] == ["REGULAR"]
    value = public_policy(replace(current, purposes=("bars.minute.ALL",), markets=("HK",)))
    assert value["historyFrames"] == [] and value["historyMinuteSessions"] == []
    value = public_policy(replace(current, purposes=("bars.minute.ALL",), markets=("US",)))
    assert value["historyFrames"] == ["minute"] and value["historyMinuteSessions"] == ["ALL"]
