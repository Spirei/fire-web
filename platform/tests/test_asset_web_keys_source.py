"""Frozen Node Web parser and icon relationship vectors; no database enrollment."""

import hashlib
import json
import subprocess
from pathlib import Path

from alcor_api.asset_web_keys import RELATED, icon_rows, related_icons, select_web_keys, stock_codes


def test_web_keys_truncate_before_filter_and_keep_original_stock_pairs():
    root = Path(__file__).parent / "fixtures/asset-management-source"
    for name, digest in json.loads((root / "source.json").read_text()).items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest
    vectors = [
        {"type": "flag", "keys": " us ,US,1x,ＡＡ,ß, cn ,EU"},
        {"type": "flag", "keys": ",".join(["!"] * 50 + ["US"])},
        {"type": "flag", "keys": ",".join(["us"] * 50 + ["CN"])},
        {"type": "stock", "keys": "US:demo.oq,:bad,HK:9992, US : demo ,US:,x,US:a:b,US:demo.oq"},
        {"type": "stock", "keys": ",".join(["bad"] * 200 + ["US:DEMO"])},
        {"type": "stock", "market": " hk ", "code": " 9992 "},
        {"type": "flag", "keys": ""},
        {"type": "icon", "keys": "US"},
        {"type": "stock", "code": "DEMO"},
    ]
    run = subprocess.run(
        [
            "node",
            "--experimental-vm-modules",
            str(Path(__file__).with_name("asset_web_keys_source.cjs")),
            str(root),
        ],
        input=json.dumps(vectors),
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    golden = json.loads(run.stdout)
    assert [
        select_web_keys(q["type"], q.get("keys"), q.get("market"), q.get("code")) for q in vectors
    ] == golden["parsed"]
    assert RELATED == golden["related"]
    assert [
        stock_codes(market, code)
        for market, code in [("HK", "9992"), ("HK", "00000"), ("US", "demo.oq"), ("JP", " abc.t ")]
    ] == golden["codes"]
    assert [
        related_icons({"US:NVDL": "etf", "US:NVDA": "main"}),
        related_icons({"US:NVDL": "etf"}),
    ] == golden["maps"]
    rows = icon_rows("stock", related_icons({"US:NVDL": "etf", "US:NVDA": "main"}))
    assert all(row["price"] is None and row["marketCap"] is None for row in rows)
    assert next(row for row in rows if row["code"] == "NVDL")["url"] == "main"


async def test_web_icon_service_reads_existing_rows_and_never_publishes_missing_bytes():
    from contextlib import asynccontextmanager

    from alcor_api.asset_catalog_management import AssetManagement

    records = [
        {"id": "stock:HK:09992", "type": "stock", "market": "HK", "code": "09992", "image": "/verified/hk"},
        {"id": "stock:US:DEMO", "type": "stock", "market": "US", "code": "DEMO", "image": ""},
        {"id": "stock:US:NVDA", "type": "stock", "market": "US", "code": "NVDA", "image": "/verified/nvda"},
        {"id": "stock:US:NVDL", "type": "stock", "market": "US", "code": "NVDL", "image": "/verified/etf"},
        {"id": "flag:US", "type": "flag", "market": "OTHER", "code": "US", "image": "/verified/us"},
    ]
    calls = []

    class Cursor:
        def __init__(self, row):
            self.row = row

        async def fetchone(self):
            return self.row

        async def fetchall(self):
            return self.row

    class Catalog:
        @asynccontextmanager
        async def context(self):
            yield self

        async def execute(self, sql, args=None):
            assert "SELECT" in sql and "INSERT" not in sql
            if sql == "SELECT asset_id FROM asset_catalog_tombstones WHERE restored_at IS NULL":
                assert args is None
                return Cursor([])
            known = sql.startswith("SELECT 1 FROM asset_catalog_entries WHERE")
            assert known or "NOT EXISTS" in sql and "asset_catalog_tombstones" in sql
            calls.append(args)
            kind, code, _, market = args
            return Cursor(
                next(
                    (
                        r
                        for r in records
                        if r["type"] == kind
                        and r["code"] == code
                        and (kind == "flag" or r["market"] == market)
                    ),
                    None,
                )
            )

        async def project(self, conn, row, cache, budget):
            return {"imageUrl": row["image"]}

    service = AssetManagement(Catalog())
    result = await service.web_icons("stock", select_web_keys("stock", "HK:9992,US:DEMO,US:NVDL,US:NVDA"))
    mapping = {row["market"] + ":" + row["code"]: row["url"] for row in result["assets"]}
    assert mapping["HK:09992"] == mapping["HK:9992"] == "/verified/hk"
    assert "US:DEMO" not in mapping
    assert mapping["US:NVDL"] == mapping["US:NVDA"] == "/verified/nvda"
    result = await service.web_icons("stock", select_web_keys("stock", "US:NVDL"))
    assert result == {"assets": []}
    result = await service.web_icons("flag", select_web_keys("flag", "us,US,cn"))
    assert [row["code"] for row in result["assets"]] == ["US"]
    assert result["assets"][0]["marketCap"] is None
    assert all(args[0] in ("stock", "flag") for args in calls)
