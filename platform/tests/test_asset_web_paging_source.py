import json
import math
import subprocess
from pathlib import Path

from alcor_api.asset_web_paging import sqlite_like_contains, web_page_number


def test_web_paging_uses_frozen_sqlite_like_and_number_vectors():
    records = [
        ("AA", "Alpha"),
        ("AB", "aLPha"),
        ("AC", "École"),
        ("AD", "école"),
        ("AE", "a_b"),
        ("AF", "a%b"),
        ("AG", "two\nlines"),
    ]
    queries = [
        {"q": q} for q in ("", "alpha", "%", "_", "a_b", "a%b", "É", "é", "[A]", "two_lines", "\\", "\0")
    ]
    queries += [
        {"page": value, "pageSize": value}
        for value in (
            "",
            "0",
            "-1",
            "0.5",
            "1.9",
            "Infinity",
            "-Infinity",
            "NaN",
            "0x10",
            "0b10",
            "1e99",
            "0x" + "f" * 300,
            "bad",
        )
    ]
    queries += [
        {"sort": sort, "dir": direction}
        for sort in ("code", "name", "board", "price", "changePct", "marketCap", "rank", "invalid")
        for direction in ("asc", "desc")
    ]
    fixture = Path(__file__).parent / "fixtures/asset-management-source"
    golden = json.loads(
        subprocess.run(
            [
                "node",
                "--experimental-vm-modules",
                str(Path(__file__).with_name("asset_web_paging_source.cjs")),
                str(fixture),
            ],
            input=json.dumps({"records": records, "queries": queries}),
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout
    )
    actual = []
    for query in queries:
        selected = [
            (code, name)
            for code, name in records
            if not query.get("q")
            or sqlite_like_contains(code, query["q"])
            or sqlite_like_contains(name, query["q"])
        ]
        selected.sort()
        if query.get("sort") in ("code", "name"):
            index = 0 if query["sort"] == "code" else 1
            selected.sort(key=lambda record: record[index], reverse=query.get("dir") == "desc")
        size = web_page_number(query.get("pageSize"), 10, 100)
        page = min(web_page_number(query.get("page")), max(1, math.ceil(len(selected) / size)))
        actual.append(
            {
                "codes": [code for code, _ in selected[(page - 1) * size : page * size]],
                "page": page,
                "pageSize": size,
                "total": len(selected),
            }
        )
    assert actual == golden


async def test_catalog_keeps_web_wildcards_separate_from_app_substrings():
    from contextlib import asynccontextmanager

    from alcor_api.asset_catalog_management import AssetManagement

    rows = [
        {"id": "stock:US:" + code, "type": "stock", "market": "US", "code": code, "name": name}
        for code, name in [("AA", "Alpha"), ("AB", "a_b"), ("AC", "a%b"), ("AD", "École"), ("AE", "école")]
    ]

    class Cursor:
        def __init__(self, value):
            self.value = value

        async def fetchall(self):
            return self.value

        async def fetchone(self):
            return self.value

    class Catalog:
        @asynccontextmanager
        async def context(self):
            yield self

        async def execute(self, sql, args=None):
            assert sql.lstrip().startswith("SELECT ")
            if "SELECT revision" in sql:
                return Cursor({"revision": 0})
            if sql == "SELECT asset_id FROM asset_catalog_tombstones WHERE restored_at IS NULL":
                assert args is None
                return Cursor([])
            assert "asset_catalog_tombstones" in sql
            return Cursor(rows)

        async def project(self, conn, row, cache, budget):
            return row

    service = AssetManagement(Catalog())
    web = await service.listing(
        kind="stock", q="a_b", sort="code", direction="asc", clamp=True, page=math.inf
    )
    assert [row["code"] for row in web["assets"]] == ["AB", "AC"]
    app = await service.listing(kind="stock", q="a_b")
    assert [row["code"] for row in app["assets"]] == ["AB"]
    web = await service.listing(kind="stock", q="É", sort="code", direction="asc", clamp=True)
    assert [row["code"] for row in web["assets"]] == ["AD"]
    app = await service.listing(kind="stock", q="É")
    assert [row["code"] for row in app["assets"]] == ["AD", "AE"]


def test_public_like_wildcards_do_not_use_exponential_regex_backtracking():
    assert sqlite_like_contains("%precedingX", "X")
    assert not sqlite_like_contains("A" * 120, "%A" * 40 + "%Z")
    assert sqlite_like_contains("A" * 120, "%A" * 40)
