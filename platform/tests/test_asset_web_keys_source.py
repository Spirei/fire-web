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
    from alcor_api.asset_lookup_contract import image_key

    records = [
        {"id": "stock:HK:09992", "type": "stock", "market": "HK", "code": "09992", "light_version": "v-hk", "dark_version": None},
        {"id": "stock:US:DEMO", "type": "stock", "market": "US", "code": "DEMO", "light_version": None, "dark_version": None},
        {"id": "stock:US:NVDA", "type": "stock", "market": "US", "code": "NVDA", "light_version": "v-nvda", "dark_version": None},
        {"id": "stock:US:NVDL", "type": "stock", "market": "US", "code": "NVDL", "light_version": "v-etf", "dark_version": None},
        {"id": "stock:US:DEL", "type": "stock", "market": "US", "code": "DEL", "light_version": "v-del", "dark_version": None},
        {"id": "flag:US", "type": "flag", "market": "OTHER", "code": "US", "light_version": "v-us", "dark_version": None},
    ]
    digests = {"v-hk": "h", "v-nvda": "n", "v-etf": "e", "v-del": "d", "v-us": "f"}
    calls = []

    class Cursor:
        def __init__(self, row):
            self.row = row

        async def fetchone(self):
            return self.row

        async def fetchall(self):
            return self.row

    def projected(record):
        version_id = record["light_version"]
        return {
            "id": record["id"],
            "type": record["type"],
            "market": record["market"],
            "code": record["code"],
            "light_version": version_id,
            "light_kind": "asset" if version_id else None,
            "light_folder": ("flag" if version_id == "v-us" else "stock") if version_id else None,
            "light_sha256": digests[version_id] * 64 if version_id else None,
            "light_size": 1 if version_id else None,
        }

    class Catalog:
        @asynccontextmanager
        async def context(self):
            yield self

        async def execute(self, sql, args=None):
            calls.append(sql)
            assert "INSERT" not in sql and "UPDATE" not in sql and "DELETE" not in sql
            if "asset_catalog_tombstones" in sql:
                assert args is None
                return Cursor([{"asset_id": "stock:US:DEL"}])
            assert "LEFT JOIN system_asset_versions" in sql
            if "unnest" in sql:
                markets, codes, kind = args
                wanted = set(zip(markets, codes))
                matched = [r for r in records if r["type"] == kind and (r["market"].upper(), r["code"].upper()) in wanted]
            else:
                kind, codes = args
                matched = [r for r in records if r["type"] == kind and r["code"] in codes]
            return Cursor([projected(r) for r in matched])

        async def image(self, conn, identifier, kind, budget):
            version = budget["versions"].get(identifier)
            assert version is not None, "icon versions must be preloaded with the entries"
            if version["folder"] != kind:
                return None, "unregistered-image"
            return version, "registered-shared-image"

    class Legacy:
        def __init__(self):
            self.projected = []

        async def matching(self, kind, market, codes):
            if kind == "stock" and market == "US" and "DEL" in codes:
                return [{"id": "stock:US:DEL", "type": "stock", "market": "US", "code": "DEL"}]
            return []

        async def project(self, row, budget):
            self.projected.append(row)
            return {"imageUrl": "/legacy/" + row["id"]}

    legacy = Legacy()
    service = AssetManagement(Catalog(), legacy)
    result = await service.web_icons("stock", select_web_keys("stock", "HK:9992,US:DEMO,US:NVDL,US:NVDA,US:DEL"))
    mapping = {row["market"] + ":" + row["code"]: row["url"] for row in result["assets"]}
    assert mapping["HK:09992"] == mapping["HK:9992"] == f"/api/asset-image/{image_key('stock:HK:09992', 'light')}?v=" + "h" * 12
    assert "US:DEMO" not in mapping
    assert mapping["US:NVDL"] == mapping["US:NVDA"] == f"/api/asset-image/{image_key('stock:US:NVDA', 'light')}?v=" + "n" * 12
    # A registered tombstone is authoritative; the filename fallback must not revive it.
    assert "US:DEL" not in mapping
    assert legacy.projected == []
    # One tombstone read and one entry/version read — never one query per code.
    assert len(calls) == 2
    calls.clear()
    result = await service.web_icons("stock", select_web_keys("stock", "US:NVDL"))
    assert result == {"assets": []}
    assert len(calls) == 2
    calls.clear()
    result = await service.web_icons("flag", select_web_keys("flag", "us,US,cn"))
    assert [row["code"] for row in result["assets"]] == ["US"]
    assert result["assets"][0]["marketCap"] is None
    assert len(calls) == 2
