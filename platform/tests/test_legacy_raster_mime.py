"""Legacy public filenames retain original bytes; new uploads remain strict."""
import hashlib
import io
import json

from fastapi import HTTPException
from PIL import Image
import pytest

from alcor_api.legacy_asset_codec import display_bytes
from alcor_api.legacy_card_directory import LegacyCardDirectory
from alcor_api.system_asset_codec import image_bytes


def jpeg():
    stream = io.BytesIO()
    Image.new('RGB', (32, 20), '#728497').save(stream, format='JPEG')
    return stream.getvalue()


def test_mislabeled_legacy_raster_uses_verified_actual_mime_but_upload_stays_strict():
    raw = jpeg()
    assert display_bytes(raw, 'png') == (raw, 'image/jpeg')
    with pytest.raises(HTTPException):
        image_bytes(raw, 'png')
    for bad in (b'<script>alert(1)</script>', b'\xff\xd8\xffbroken', raw[:100]):
        with pytest.raises(HTTPException):
            display_bytes(bad, 'png')
    with pytest.raises(HTTPException):
        display_bytes(raw, 'svg')


def test_manifest_card_read_preserves_filename_hash_bytes_and_filesystem(tmp_path):
    cards = tmp_path / 'cards'
    cards.mkdir()
    raw = jpeg()
    target = cards / 'historical.png'
    target.write_bytes(raw)
    (cards / 'manifest.json').write_text(json.dumps({'regions':[{'label':'Example','banks':[{'name':'Example bank','cards':[{'name':'Example card','file':'historical.png'}]}]}]}))
    before = target.stat()
    row, stream = LegacyCardDirectory(tmp_path).open_bytes('cards/historical.png')
    assert stream.read() == raw
    assert row['media_type'] == 'image/jpeg'
    assert row['served_sha256'] == row['original_sha256'] == hashlib.sha256(raw).hexdigest()
    assert target.read_bytes() == raw and target.stat().st_mtime_ns == before.st_mtime_ns


def test_legacy_svg_editor_metadata_is_removed_only_from_safe_presentation():
    raw = b'<svg xmlns="http://www.w3.org/2000/svg" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Legacy title</dc:title></metadata><path d="M0 0h20v20z"/></svg>'
    shown, mime = display_bytes(raw, 'svg')
    assert mime == 'image/svg+xml' and b'Legacy title' not in shown and b'path' in shown
    for unsafe in (
        b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        b'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/photo.png"/></svg>',
        b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>',
    ):
        with pytest.raises(HTTPException):
            display_bytes(unsafe, 'svg')


def test_explicit_manifest_svg_above_upload_limit_is_bounded_and_read_only(tmp_path):
    cards = tmp_path / 'cards'
    cards.mkdir()
    raw = b'<!--' + b' ' * (2 * 1024 * 1024) + b'--><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h20v20z"/></svg>'
    target = cards / 'large.svg'
    target.write_bytes(raw)
    (cards / 'manifest.json').write_text(json.dumps({'regions':[{'label':'Example','banks':[{'name':'Bank','cards':[{'name':'Large','file':'large.svg'}]}]}]}))
    info, _ = LegacyCardDirectory(tmp_path).open_bytes('cards/large.svg')
    assert info['original_sha256'] == hashlib.sha256(raw).hexdigest()
    assert target.read_bytes() == raw
