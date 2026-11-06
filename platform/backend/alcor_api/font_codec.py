"""Bounded actual SFNT/WOFF decoding; source bytes are never rewritten."""

import asyncio
import io
import posixpath
import re
import struct
import sys
import zlib

from fastapi import HTTPException

LIMIT = 10485760
UNPACK_LIMIT = 104857600
MIME = {"woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf"}
MAGIC = {"woff": b"wOFF", "woff2": b"wOF2", "ttf": b"\x00\x01\x00\x00", "otf": b"OTTO"}


def font_name(filename):
    base = posixpath.basename(filename)
    suffix = posixpath.splitext(base)[1]
    ext = suffix[1:].lower()
    name = re.sub(r"[\x00-\x1f\x7f]", "", base[: -len(suffix)] if suffix else base)
    # Match the old 60 UTF-16-unit limit without persisting a split surrogate.
    name = name.encode("utf-16-le", errors="ignore")[:120].decode("utf-16-le", errors="ignore")
    return ext, name or "自定义字体"


def header(raw, ext):
    if not raw or len(raw) > LIMIT:
        raise ValueError("size")
    if len(raw) < 48 or ext not in MAGIC or raw[:4] != MAGIC[ext]:
        raise ValueError("font signature")
    if ext.startswith("woff"):
        if struct.unpack_from(">I", raw, 8)[0] != len(raw) or not struct.unpack_from(">H", raw, 12)[0]:
            raise ValueError("WOFF header")
        if struct.unpack_from(">I", raw, 16)[0] > UNPACK_LIMIT:
            raise ValueError("WOFF expansion")
    else:
        count = struct.unpack_from(">H", raw, 4)[0]
        if not 1 <= count <= 256 or 12 + count * 16 > len(raw):
            raise ValueError("SFNT directory")
        for i in range(count):
            start, length = struct.unpack_from(">II", raw, 12 + i * 16 + 8)
            if start + length > len(raw):
                raise ValueError("SFNT bounds")


def decode(raw, ext):
    header(raw, ext)
    from fontTools.pens.basePen import NullPen
    from fontTools.ttLib import TTFont

    preflight(raw, ext)

    with TTFont(io.BytesIO(raw), lazy=False, checkChecksums=2, ignoreDecompileErrors=False) as font:
        font.ensureDecompiled()
        if not {"head", "maxp", "hhea", "hmtx", "cmap"} <= set(font.keys()):
            raise ValueError("missing font tables")
        outlines = "glyf" in font or "CFF " in font or "CFF2" in font
        bitmap = ("CBDT" in font and "CBLC" in font) or ("EBDT" in font and "EBLC" in font) or "sbix" in font
        if not outlines and not bitmap:
            raise ValueError("missing glyphs")
        if outlines:
            glyphs = font.getGlyphSet()
            pen = NullPen()
            for name in glyphs:
                glyphs[name].draw(pen)


def bounded_zlib(raw, expected):
    if expected > UNPACK_LIMIT:
        raise ValueError("font expansion")
    decoder = zlib.decompressobj()
    result = decoder.decompress(raw, expected + 1)
    if len(result) != expected or not decoder.eof or decoder.unused_data:
        raise ValueError("font compressed table")


def bounded_brotli(raw, expected):
    import brotli

    if expected > UNPACK_LIMIT:
        raise ValueError("font expansion")
    decoder = brotli.Decompressor()
    total = 0
    while True:
        out = decoder.process(raw, output_buffer_limit=65536)
        raw = b""
        total += len(out)
        if total > expected:
            raise ValueError("font compressed stream expansion")
        if decoder.is_finished():
            break
        if not out:
            raise ValueError("font compressed stream incomplete")
    if total != expected:
        raise ValueError("font compressed stream length")


def preflight(raw, ext):
    if ext == "woff2":
        from fontTools.ttLib.woff2 import WOFF2DirectoryEntry

        reader = io.BytesIO(raw)
        reader.seek(48)
        expected = 0
        for _ in range(struct.unpack_from(">H", raw, 12)[0]):
            entry = WOFF2DirectoryEntry()
            entry.fromFile(reader)
            expected += entry.length
            if expected > UNPACK_LIMIT:
                raise ValueError("font tables expansion")
        length = struct.unpack_from(">I", raw, 20)[0]
        compressed = reader.read(length)
        if len(compressed) != length:
            raise ValueError("font compressed bounds")
        bounded_brotli(compressed, expected)
        meta = struct.unpack_from(">III", raw, 28)
    elif ext == "woff":
        count = struct.unpack_from(">H", raw, 12)[0]
        if 44 + count * 20 > len(raw):
            raise ValueError("font directory bounds")
        total = 0
        for i in range(count):
            start, compressed, original = struct.unpack_from(">III", raw, 44 + i * 20 + 4)
            total += original
            if start + compressed > len(raw) or compressed > original or total > UNPACK_LIMIT:
                raise ValueError("font table bounds")
            if compressed != original:
                bounded_zlib(raw[start : start + compressed], original)
        meta = struct.unpack_from(">III", raw, 24)
    else:
        total = sum(
            struct.unpack_from(">I", raw, 12 + i * 16 + 12)[0]
            for i in range(struct.unpack_from(">H", raw, 4)[0])
        )
        if total > UNPACK_LIMIT:
            raise ValueError("font table expansion")
        return
    offset, length, expected = meta
    if offset:
        if offset + length > len(raw):
            raise ValueError("font metadata bounds")
        (bounded_brotli if ext == "woff2" else bounded_zlib)(raw[offset : offset + length], expected)


async def memory_guard(child, maximum=512 * 1024 * 1024):
    """Darwin lacks an enforceable RLIMIT_AS; watch the isolated worker's RSS."""
    while child.returncode is None:
        probe = None
        try:
            probe = await asyncio.create_subprocess_exec(
                "/bin/ps",
                "-o",
                "rss=",
                "-p",
                str(child.pid),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            result = await asyncio.wait_for(probe.stdout.read(33), timeout=1)
            if len(result) > 32 or not result.strip().isdigit() or int(result) * 1024 > maximum:
                try:
                    child.kill()
                except ProcessLookupError:
                    pass
                return
        except (TimeoutError, OSError):
            try:
                child.kill()
            except ProcessLookupError:
                pass
            return
        finally:
            if probe is not None:
                if probe.returncode is None:
                    try:
                        probe.kill()
                    except ProcessLookupError:
                        pass
                await probe.wait()
        await asyncio.sleep(0.05)


async def validate_font(raw, ext):
    if not raw or len(raw) > LIMIT:
        raise HTTPException(413 if len(raw) > LIMIT else 400, "字体不能超过 10 MB")
    try:
        header(raw, ext)
    except (ValueError, struct.error):
        raise HTTPException(400, "请选择有效的字体文件") from None
    try:
        child = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "alcor_api.font_codec",
            "--worker",
            ext,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        raise HTTPException(503, "字体解析进程尚不可用，请核对原回执") from None
    monitor = asyncio.create_task(memory_guard(child)) if sys.platform == "darwin" else None
    try:
        await asyncio.wait_for(child.communicate(raw), timeout=10)
        if child.returncode == 2:
            raise HTTPException(400, "字体文件无效")
        if child.returncode != 0:
            raise HTTPException(503, "字体解析未完成，请核对原回执")
    except TimeoutError:
        raise HTTPException(503, "字体解析超出本次预算，请核对原回执") from None
    finally:
        if monitor:
            monitor.cancel()
            try:
                await monitor
            except asyncio.CancelledError:
                pass
        if child.returncode is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass
            await child.wait()


def worker():
    import resource

    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    if sys.platform != "darwin":
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    raw = sys.stdin.buffer.read(LIMIT + 1)
    try:
        import brotli
        from fontTools.ttLib import TTLibError

        decode(raw, sys.argv[2])
    except (MemoryError, ImportError):
        return 3
    except (
        TTLibError,
        brotli.error,
        AssertionError,
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        OverflowError,
        EOFError,
        RecursionError,
        NotImplementedError,
        struct.error,
        zlib.error,
    ):
        return 2
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--worker":
        raise SystemExit(2)
    raise SystemExit(worker())
