"""Read-only compatibility for explicitly public uploads/asset folders.

No seeding, renaming, chmod, database writes, or traversal of private uploads.
Registered metadata and tombstones always take precedence over filename hints.
"""

import asyncio
import hashlib
import io
import json
from importlib.resources import files
import os
import re
import stat
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException

from .system_asset_codec import FOLDERS
from .legacy_asset_codec import display_bytes

REGION_NAMES = json.loads(files("alcor_api").joinpath("data/asset_region_names.json").read_text())

EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "svg"}
LIMIT = 10 * 1024 * 1024
SVG_LIMIT = 2 * 1024 * 1024

MARKET_NAMES = {
    "US": "美股",
    "HK": "港股",
    "CN": "A股",
    "JP": "日股",
    "KR": "韩股",
    "SG": "新加坡",
    "UK": "英国",
    "DE": "德国",
    "FR": "法国",
    "AU": "澳大利亚",
    "CA": "加拿大",
    "IN": "印度",
    "TW": "台湾",
    "BR": "巴西",
    "SPX": "标普500",
}
MARKET_ALIASES = {label + key: key for key, label in MARKET_NAMES.items()} | {"美国US": "US"}


def public_upload_root(settings):
    # Fire keeps public uploads separate from private originals and backups.
    if settings.connections_from_environment:
        return settings.public_upload_root
    return settings.public_upload_root or settings.file_root


def market_key(stem):
    raw = stem.upper()
    if raw in MARKET_NAMES:
        return raw
    if stem in MARKET_ALIASES:
        return MARKET_ALIASES[stem]
    match = re.fullmatch(r"([A-Z]{2,3})-[a-fA-F0-9]{12,64}", stem)
    return match[1] if match and match[1] in MARKET_NAMES else raw


def filename_fields(kind, stem):
    # Match the old Web category parser, retaining each physical original.
    suffix = re.search(r"([A-Z0-9]{2,})$" if kind in ('crypto', 'metal') else r"([A-Za-z0-9][A-Za-z0-9._-]*)$", stem)
    code = (suffix[1] if suffix else stem).upper()
    name = stem[:suffix.start()].rstrip(" _-") if suffix and suffix.start() else stem
    if kind == 'flag' and name.upper() == code:
        name = REGION_NAMES.get(code, name)
    if kind == 'market':
        code = market_key(stem)
        name = MARKET_NAMES.get(code, stem)
    return code, name or stem


def parts_for(path):
    parts = path.split("/")
    if (
        len(parts) < 3
        or len(parts) > 7
        or parts[0] != "asset"
        or parts[1] not in FOLDERS
        or (parts[1] == "group" and len(parts) != 3)
        or any(not p or p.startswith(".") or "\\" in p or any(ord(c) < 32 for c in p) for p in parts)
        or Path(parts[-1]).suffix.lower().lstrip(".") not in EXTENSIONS
    ):
        raise HTTPException(404, "素材不存在")
    return parts


class LegacyAssetDirectory:
    def __init__(self, root):
        self.root = root
        self.cached = None
        self.grouped = None
        self.until = 0
        self.lock = asyncio.Lock()

    def root_fd(self):
        if self.root is None:
            raise FileNotFoundError()
        return os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def path_parts(self, path):
        return parts_for(path)

    def read_original(self, path):
        parts = self.path_parts(path)
        limit = SVG_LIMIT if Path(parts[-1]).suffix.lower() == ".svg" else LIMIT
        return self.read_parts(parts, limit)

    def read_parts(self, parts, limit):
        fd = None
        try:
            fd = self.root_fd()
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            child = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            with os.fdopen(child, "rb") as stream:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= limit:
                    raise HTTPException(404, "素材格式或大小不受支持")
                raw = stream.read(limit + 1)
                after = os.fstat(stream.fileno())
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                    after.st_size,
                    after.st_mtime_ns,
                    after.st_ctime_ns,
                ) or len(raw) != before.st_size:
                    raise HTTPException(409, "素材正在变化，请重新读取")
            return raw
        except (OSError, ValueError):
            raise HTTPException(404, "素材不存在或挂载不可读") from None
        finally:
            if fd is not None:
                os.close(fd)

    def open_bytes(self, path, expected=None):
        raw = self.read_original(path)
        served, media_type = display_bytes(raw, Path(path).suffix[1:])
        sha = hashlib.sha256(served).hexdigest()
        if expected is not None and (not re.fullmatch(r"[a-f0-9]{64}", expected) or expected != sha):
            raise HTTPException(404, "素材摘要不匹配")
        return {
            "media_type": media_type,
            "served_size": len(served),
            "served_sha256": sha,
            "original_size": len(raw),
            "original_sha256": hashlib.sha256(raw).hexdigest(),
        }, io.BytesIO(served)

    def scan(self):
        records = []
        inspected = 0

        def walk(fd, parents):
            nonlocal inspected
            with os.scandir(fd) as entries:
                for entry in entries:
                    inspected += 1
                    if inspected > 20000:
                        raise HTTPException(503, "目录超过扫描预算，请缩小公共素材目录")
                    if (
                        entry.name.startswith(".")
                        or "\\" in entry.name
                        or any(ord(c) < 32 for c in entry.name)
                    ):
                        continue
                    if entry.is_dir(follow_symlinks=False) and len(parents) < 6 and parents[1] != "group":
                        child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                        try:
                            walk(child, [*parents, entry.name])
                        finally:
                            os.close(child)
                    elif (
                        entry.is_file(follow_symlinks=False)
                        and Path(entry.name).suffix.lower()[1:] in EXTENSIONS
                    ):
                        parts = [*parents, entry.name]
                        info = entry.stat(follow_symlinks=False)
                        limit = SVG_LIMIT if Path(entry.name).suffix.lower() == ".svg" else LIMIT
                        if not 0 < info.st_size <= limit:
                            continue
                        kind = parts[1]
                        # Folder and terminal ticker are filename metadata, never a security master.
                        stem = Path(entry.name).stem
                        code, name = filename_fields(kind, stem)
                        market = (
                            parts[2].upper()
                            if kind in ("stock", "broker") and len(parts) >= 4
                            else code
                            if kind == "market"
                            else ""
                        )
                        path = "/".join(parts)
                        records.append(
                            {
                                "id": "legacy-file:" + hashlib.sha256(path.encode()).hexdigest()[:32],
                                "type": kind,
                                "market": market,
                                "code": code,
                                "name": name or stem,
                                "legacyPath": "/uploads/" + quote(path, safe="/"),
                                "relativePath": path,
                                "coverage": "filename-only",
                                "readOnly": True,
                            }
                        )

        fd = None
        try:
            fd = self.root_fd()
            asset = os.open("asset", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                for kind in sorted(FOLDERS):
                    try:
                        child = os.open(kind, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=asset)
                    except FileNotFoundError:
                        continue
                    except OSError:
                        continue  # Never follow a symlink or another special node.
                    try:
                        walk(child, ["asset", kind])
                    finally:
                        os.close(child)
            finally:
                os.close(asset)
        except FileNotFoundError:
            return []
        except OSError:
            raise HTTPException(503, "公共素材目录不可读，请核对 uploads 挂载权限") from None
        finally:
            if fd is not None:
                os.close(fd)
        return sorted(records, key=lambda r: (r["type"], r["market"], r["code"], r["relativePath"]))

    async def inventory(self):
        async with self.lock:
            if self.cached is None or time.monotonic() >= self.until:
                self.cached = await asyncio.to_thread(self.scan)
                self.grouped = None
                self.until = time.monotonic() + 5
            return self.cached

    async def entries(self):
        files = await self.inventory()
        if self.grouped is not None:
            return self.grouped
        by_stem = {
            (str(Path(r["relativePath"]).parent), Path(r["relativePath"]).stem.lower()): r for r in files
        }
        groups = {}
        for row in files:
            stem = Path(row["relativePath"]).stem
            peer = (
                by_stem.get((str(Path(row["relativePath"]).parent), stem[:-5].lower()))
                if stem.lower().endswith("-dark")
                else None
            )
            key_row = peer or row
            key = (key_row["type"], key_row["market"], key_row["code"])
            groups.setdefault(key, []).append({**row, "darkVariant": peer is not None})
        entries = []
        for (kind, market, code), variants in groups.items():
            variants.sort(
                key=lambda r: (
                    r["darkVariant"],
                    Path(r["relativePath"]).stem.upper() != code,
                    r["relativePath"],
                )
            )
            primary = variants[0]
            name = next(
                (r["name"] for r in variants if not r["darkVariant"] and r["name"].upper() != r["code"]),
                primary["name"],
            )
            identity = primary['id'] if kind == 'card' else 'legacy-file:' + hashlib.sha256(('logical:' + kind + '\0' + market + '\0' + code).encode()).hexdigest()[:32]
            entries.append({**primary, "id": identity, "code": code, "name": name, "fileVariants": variants})
        self.grouped = sorted(entries, key=lambda r: (r["type"], r["market"], r["code"]))
        return self.grouped

    async def matching(self, kind, market, codes):
        return [
            row
            for row in await self.entries()
            if row["type"] == kind and row["code"] in codes and (kind != "stock" or row["market"] == market)
        ]

    async def project(self, row, budget):
        result = {k: v for k, v in row.items() if k not in ("relativePath", "fileVariants", "darkVariant")}
        variants = []
        for variant in row.get("fileVariants", [row]):
            item = {"path": variant["legacyPath"], "dark": variant.get("darkVariant", False)}
            try:
                image, stream = await asyncio.to_thread(self.open_bytes, variant["relativePath"])
                stream.close()
                budget["bytes"] += image["served_size"]
                if budget["bytes"] > 64 * 1024 * 1024:
                    raise HTTPException(503, "素材校验超过读取预算，请缩小分页")
                item.update(
                    imageUrl=variant["legacyPath"] + "?sha256=" + image["served_sha256"],
                    originalSha256=image["original_sha256"],
                    imageState="read-only-original",
                )
            except HTTPException as exc:
                if exc.status_code == 503:
                    raise
                item.update(imageUrl=None, imageState="unavailable-or-unsafe")
            variants.append(item)
        primary = variants[0]
        dark = next((v for v in variants if v["dark"] and v.get("imageUrl")), None)
        result.update(
            imageUrl=primary.get("imageUrl"),
            imageUrlDark=dark["imageUrl"] if dark else None,
            originalSha256=primary.get("originalSha256"),
            imageState=primary["imageState"],
            fileVariants=variants,
        )
        return result
