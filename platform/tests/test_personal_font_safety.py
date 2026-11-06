import asyncio
import sys
from uuid import uuid4

import pytest
import test_personal_fonts as font_support
from alcor_api.font_codec import bounded_brotli, bounded_zlib, memory_guard
from font_fixtures import font_bytes
from test_personal_fonts import P, upload

files = font_support.files


async def test_real_worker_memory_watchdog_kills_an_exceeding_private_process():
    if sys.platform != "darwin":
        # Production Linux parser sets the actual RLIMIT_AS before reading its input.
        child = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            "import resource; resource.setrlimit(resource.RLIMIT_AS,(64*1024*1024,64*1024*1024)); bytearray(128*1024*1024)",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(child.wait(), 5)
        assert child.returncode != 0
        return
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import time; data=bytearray(96*1024*1024); time.sleep(5)",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    watcher = asyncio.create_task(memory_guard(child, maximum=48 * 1024 * 1024))
    try:
        await asyncio.wait_for(child.wait(), 3)
        await watcher
        assert child.returncode < 0
    finally:
        watcher.cancel()
        if child.returncode is None:
            child.kill()
            await child.wait()


def test_actual_brotli_and_zlib_streams_cannot_exceed_the_declared_decoded_size():
    import zlib

    import brotli

    raw = bytes(2097152)
    for decompress, compress in [(bounded_brotli, brotli.compress), (bounded_zlib, zlib.compress)]:
        compressed = compress(raw)
        decompress(compressed, len(raw))
        with pytest.raises(ValueError):
            decompress(compressed, 1)
        with pytest.raises(ValueError):
            decompress(compressed[:-1], len(raw))


async def test_same_original_uuid_concurrent_one_font_and_audit_or_disk_failure_rolls_back(
    client, admin, app, monkeypatch
):
    rid = str(uuid4())
    raw = font_bytes(seed=90)
    a, b = await asyncio.gather(
        upload(client, raw, revision=0, rid=rid), upload(client, raw, revision=0, rid=rid)
    )
    assert a[0].status_code == 200 and a[0].json() == b[0].json()
    assert len((await client.get(P)).json()["fonts"]) == 1
    async with app.state.db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_font_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'personal-fonts.%' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_font_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_font_audit()"
        )
    failed, body = await upload(client, font_bytes(seed=91))
    assert failed.status_code >= 500
    assert (await client.get(P + "/operations/" + body["requestId"])).status_code == 404
    assert len((await client.get(P)).json()["fonts"]) == 1
    async with app.state.db.connection() as conn:
        await conn.execute("DROP TRIGGER reject_font_audit ON audit_events")
    import alcor_api.resource_media as media

    def reject_fsync(*_):
        raise OSError("synthetic font fsync failure")

    with monkeypatch.context() as scope:
        scope.setattr(media.os, "fsync", reject_fsync)
        failed, body = await upload(client, font_bytes(seed=92))
        assert failed.status_code == 503
    assert (await client.get(P + "/operations/" + body["requestId"])).json() == failed.json()
    assert len((await client.get(P)).json()["fonts"]) == 1
    assert (await client.get(P)).json()["revision"] == 1
    font = a[0].json()["font"]
    assert (await client.get(font["originalPath"])).content == raw


async def test_canceling_real_decoder_waits_for_its_process_exit(monkeypatch):
    import alcor_api.font_codec as codec

    original = asyncio.create_subprocess_exec
    worker = []
    started = asyncio.Event()

    async def observe(*args, **kwargs):
        child = await original(*args, **kwargs)
        if "alcor_api.font_codec" in args:
            worker.append(child)
            started.set()
        return child

    monkeypatch.setattr(asyncio, "create_subprocess_exec", observe)
    operation = asyncio.create_task(codec.validate_font(font_bytes(), "ttf"))
    await asyncio.wait_for(started.wait(), 3)
    operation.cancel()
    with pytest.raises(asyncio.CancelledError):
        await operation
    assert worker and worker[0].returncode is not None


async def test_decoder_start_failure_is_known_original_uuid_failure(client, admin, monkeypatch):
    async def fail_start(*_, **__):
        raise OSError("synthetic process exhaustion")

    with monkeypatch.context() as scope:
        scope.setattr(asyncio, "create_subprocess_exec", fail_start)
        failed, body = await upload(client)
        assert failed.status_code == 503
    assert (await client.get(P + "/operations/" + body["requestId"])).json() == failed.json()
    assert (await client.get(P)).json()["fonts"] == []
