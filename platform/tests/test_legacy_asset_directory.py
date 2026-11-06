import hashlib
from urllib.parse import unquote, urlsplit

import pytest
from fastapi import HTTPException

from alcor_api.legacy_asset_directory import LegacyAssetDirectory

SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24v24z"/></svg>'


def write(root, path, raw=SVG):
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(raw)
    return file


async def test_directory_is_read_only_preserves_unicode_and_skips_private_symlinks(tmp_path):
    original = write(tmp_path, "asset/stock/HK/示例00700.svg")
    write(tmp_path, "avatar/private.svg")
    write(tmp_path, "cards/private.svg")
    write(
        tmp_path,
        "asset/icon/unsafe.svg",
        b'<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>',
    )
    (tmp_path / "asset/icon/link.svg").symlink_to(original)
    (tmp_path / "asset/flag").symlink_to(tmp_path / "avatar", target_is_directory=True)
    before = {
        str(p.relative_to(tmp_path)): (p.read_bytes(), p.stat().st_mode)
        for p in tmp_path.rglob("*")
        if p.is_file() and not p.is_symlink()
    }
    directory = LegacyAssetDirectory(tmp_path)
    rows = await directory.inventory()
    assert {(r["type"], r["code"]) for r in rows} == {("stock", "00700"), ("icon", "UNSAFE")}
    row = next(r for r in rows if r["type"] == "stock")
    assert row["market"] == "HK" and row["name"] == "示例"
    image = await directory.project(row, {"bytes": 0})
    assert unquote(urlsplit(image["imageUrl"]).path) == "/uploads/asset/stock/HK/示例00700.svg"
    assert image["originalSha256"] == hashlib.sha256(SVG).hexdigest()
    assert image["readOnly"] is True and image["coverage"] == "filename-only"
    unsafe = await directory.project(next(r for r in rows if r["type"] == "icon"), {"bytes": 0})
    assert unsafe["imageUrl"] is None
    after = {
        str(p.relative_to(tmp_path)): (p.read_bytes(), p.stat().st_mode)
        for p in tmp_path.rglob("*")
        if p.is_file() and not p.is_symlink()
    }
    assert before == after


@pytest.mark.parametrize(
    "path",
    [
        "avatar/private.svg",
        "cards/private.svg",
        "asset/icon/../secret.svg",
        "asset/icon/.secret.svg",
        "asset/icon/a\\b.svg",
        "asset/icon/file.html",
        "asset/stock//bad.svg",
    ],
)
def test_directory_rejects_private_and_unsafe_paths(tmp_path, path):
    with pytest.raises(HTTPException):
        LegacyAssetDirectory(tmp_path).open_bytes(path)


def test_symlink_swap_and_digest_mismatch_never_serve_other_bytes(tmp_path):
    source = write(tmp_path, "asset/icon/example.svg")
    directory = LegacyAssetDirectory(tmp_path)
    with pytest.raises(HTTPException):
        directory.open_bytes("asset/icon/example.svg", "0" * 64)
    source.unlink()
    secret = write(tmp_path, "avatar/private.svg")
    source.symlink_to(secret)
    with pytest.raises(HTTPException):
        directory.open_bytes("asset/icon/example.svg")


async def test_empty_and_unconfigured_directories_are_empty(tmp_path):
    assert await LegacyAssetDirectory(None).inventory() == []
    assert await LegacyAssetDirectory(tmp_path).inventory() == []


def test_safe_embedded_raster_svg_is_rendered_without_rewriting_original(tmp_path):
    import base64
    import io
    from PIL import Image

    image = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(image, "PNG")
    data = base64.b64encode(image.getvalue()).decode()
    raw = f'<svg xmlns="http://www.w3.org/2000/svg"><image width="2" height="2" href="data:image/png;base64,{data}"/></svg>'.encode()
    original = write(tmp_path, "asset/icon/embedded.svg", raw)
    metadata, preview = LegacyAssetDirectory(tmp_path).open_bytes("asset/icon/embedded.svg")
    assert b"image/png;base64," in preview.read()
    assert metadata["original_sha256"] == hashlib.sha256(raw).hexdigest()
    assert original.read_bytes() == raw
    for invalid in [
        raw.replace(b"data:image/png;base64,", b"https://tracker.invalid/"),
        raw.replace(b"<image", b'<image onload="alert(1)"'),
        raw.replace(data.encode(), b"bm90IGEgcG5n"),
    ]:
        write(tmp_path, "asset/icon/unsafe-embedded.svg", invalid)
        with pytest.raises(HTTPException):
            LegacyAssetDirectory(tmp_path).open_bytes("asset/icon/unsafe-embedded.svg")


async def test_aliases_and_dark_variants_keep_all_original_paths(tmp_path):
    write(tmp_path, "asset/icon/about.svg")
    write(tmp_path, "asset/icon/about-dark.svg", SVG.replace(b"M0 0", b"M1 1"))
    write(tmp_path, "asset/crypto/BTC.svg")
    write(tmp_path, "asset/crypto/示例币BTC.svg")
    directory = LegacyAssetDirectory(tmp_path)
    entries = await directory.entries()
    assert len(entries) == 2
    icon = await directory.project(next(r for r in entries if r["type"] == "icon"), {"bytes": 0})
    assert icon["code"] == "ABOUT" and icon["imageUrlDark"].startswith("/uploads/asset/icon/about-dark.svg?")
    assert len(icon["fileVariants"]) == 2
    crypto = next(r for r in entries if r["type"] == "crypto")
    assert crypto["code"] == "BTC" and crypto["name"] == "示例币" and len(crypto["fileVariants"]) == 2
    assert len(await directory.inventory()) == 4


async def test_legacy_raster_over_two_mebibytes_is_kept_with_bounded_read(tmp_path):
    raw = b"\x89PNG\r\n\x1a\n" + b"x" * (3 * 1024 * 1024)
    write(tmp_path, "asset/stock/US/LARGE.png", raw)
    directory = LegacyAssetDirectory(tmp_path)
    entries = await directory.entries()
    assert len(entries) == 1
    image = await directory.project(entries[0], {"bytes": 0})
    assert image["originalSha256"] == hashlib.sha256(raw).hexdigest()
    write(tmp_path, "asset/stock/US/TOO-LARGE.png", raw * 4)
    with pytest.raises(HTTPException):
        directory.open_bytes("asset/stock/US/TOO-LARGE.png")


async def test_market_aliases_are_one_market_with_every_original_retained(tmp_path):
    for name in ["US.svg", "美股US.svg", "美国US.svg", "US-0123456789ab.svg"]:
        write(tmp_path, "asset/market/" + name)
    for name in ["CN.svg", "A股CN.svg"]:
        write(tmp_path, "asset/market/" + name)
    directory = LegacyAssetDirectory(tmp_path)
    entries = await directory.entries()
    assert len(entries) == 2
    assert [(r["code"], r["market"], r["name"]) for r in entries] == [("CN", "CN", "A股"), ("US", "US", "美股")]
    assert len(next(r for r in entries if r["code"] == "US")["fileVariants"]) == 4
    assert len(await directory.inventory()) == 6

def test_category_filename_parser_follows_old_web_uppercase_ticker_suffix_without_changing_files():
    from alcor_api.legacy_asset_directory import filename_fields
    assert filename_fields('crypto','AaveAAVE') == ('AAVE','Aave')
    assert filename_fields('crypto','AvalancheAVAX') == ('AVAX','Avalanche')
    assert filename_fields('metal','白银SILVER') == ('SILVER','白银')
    assert filename_fields('crypto','BTC') == ('BTC','BTC')

async def test_logical_identity_survives_a_new_preferred_filename_variant(tmp_path):
    write(tmp_path,'asset/stock/US/示例DEMO.svg')
    before=(await LegacyAssetDirectory(tmp_path).entries())[0]
    write(tmp_path,'asset/stock/US/DEMO.svg')
    after=(await LegacyAssetDirectory(tmp_path).entries())[0]
    assert after['id']==before['id']
    assert len(after['fileVariants'])==2
    assert (tmp_path/'asset/stock/US/示例DEMO.svg').read_bytes()==SVG
