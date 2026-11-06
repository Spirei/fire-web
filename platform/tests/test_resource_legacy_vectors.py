"""Vectors captured from the real old pure TypeScript classifier, with no DB import."""

import base64
import json
from pathlib import Path

import pytest
from alcor_api.resource_contract import classify, name
from fastapi import HTTPException

VECTORS = json.loads(Path(__file__).with_name("resource-legacy-golden.json").read_text())["vectors"]


@pytest.mark.parametrize("vector", VECTORS, ids=lambda x: x["name"])
def test_actual_legacy_classification_and_hidden_files(vector):
    raw = base64.b64decode(vector["base64"])
    if "status" in vector:
        with pytest.raises(HTTPException) as caught:
            classify(raw, vector["name"], "components")
        assert caught.value.status_code == vector["status"]
    else:
        kind, mime = classify(raw, vector["name"], "components")
        assert {"kind": kind, "mime": mime} == vector["result"]


def test_ecmascript_trim_not_python_whitespace_and_raw_utf8_limits():
    assert name("\u0085permitted") == "\u0085permitted"
    for value in ["\ufeffforbidden", "forbidden\ufeff", "\u00a0forbidden", "a" * 121, "汉" * 81]:
        with pytest.raises(HTTPException):
            name(value)


@pytest.mark.parametrize("broken", [False, True])
async def test_private_stream_closes_even_before_first_chunk_or_on_failure(broken):
    import io

    from alcor_api.resource_api import PrivateResourceResponse
    from starlette.requests import ClientDisconnect

    original = io.BytesIO(b"synthetic original")

    async def source():
        if broken:
            raise OSError("synthetic stream failure")
        yield original.read()

    async def receive():
        return {"type": "http.disconnect"}

    async def send(_message):
        if broken:
            raise OSError("synthetic disconnected peer")

    response = PrivateResourceResponse(original, source())
    try:
        await response({"type": "http", "method": "GET", "asgi": {"spec_version": "2.4"}}, receive, send)
    except (OSError, ExceptionGroup, ClientDisconnect):
        assert broken
    assert original.closed
