"""Frozen legacy result and the public endpoint's complete request boundary."""

import hashlib
import json
from pathlib import Path

import httpx
import pytest
from alcor_api.country_catalog_api import CATALOG_PATH, CATALOG_SHA256, mount_country_catalog
from fastapi import FastAPI

FIXTURES = Path(__file__).with_name("fixtures")


def test_catalog_source_and_frozen_node_result_are_identified():
    provenance = json.loads((FIXTURES / "country-catalog-provenance.json").read_bytes())
    assert (
        hashlib.sha256((FIXTURES / "country-catalog-source.ts").read_bytes()).hexdigest()
        == provenance["sourceSha256"]
    )
    assert hashlib.sha256(CATALOG_PATH.read_bytes()).hexdigest() == provenance["dataSha256"] == CATALOG_SHA256
    assert provenance["icu"] == "78.3" and provenance["countryCount"] == 250
    countries = json.loads(CATALOG_PATH.read_bytes())["countries"]
    assert len(countries) == len({row["iso2"] for row in countries}) == 250
    for row in countries:
        assert set(row) == {"mapName", "iso2", "name", "flag", "flagCode"}
        assert row["flagCode"] == row["iso2"].lower()
        assert row["flag"] == "".join(chr(127397 + ord(char)) for char in row["iso2"])
    by_code = {row["iso2"]: row for row in countries}
    assert by_code["EU"] == {
        "mapName": "European Union",
        "iso2": "EU",
        "name": "欧盟",
        "flag": "🇪🇺",
        "flagCode": "eu",
    }
    assert by_code["HK"]["name"] == "中国香港"
    assert by_code["MO"]["name"] == "中国澳门"
    assert by_code["TW"]["name"] == "中国台湾"


async def test_public_catalog_keeps_the_exact_order_without_authentication_or_any_database():
    app = FastAPI()
    mount_country_catalog(app)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        for suffix, headers in (
            ("", {}),
            ("?unknown=value", {"Authorization": "Bearer invalid"}),
            ("", {"Origin": "https://other.invalid", "Cookie": "fire_session=invalid"}),
        ):
            result = await client.get("/api/countries" + suffix, headers=headers)
            assert result.status_code == 200
            assert result.content == CATALOG_PATH.read_bytes()
            assert result.headers["content-type"] == "application/json"
        assert (await client.post("/api/countries")).status_code == 405


def test_corrupted_bundle_fails_before_publishing_a_different_catalog(monkeypatch, tmp_path):
    import alcor_api.country_catalog_api as module

    replacement = tmp_path / "country_catalog.json"
    replacement.write_text('{"countries": []}')
    monkeypatch.setattr(module, "CATALOG_PATH", replacement)
    with pytest.raises(ValueError, match="country_catalog_digest_mismatch"):
        mount_country_catalog(FastAPI())
