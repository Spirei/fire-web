"""Old native resource contract: names and original bytes are lossless."""

import json
import re
import unicodedata
from pathlib import PurePosixPath
from uuid import UUID

from fastapi import HTTPException

UPLOAD_LIMIT = 50 * 1024 * 1024
QUOTA = 1024 * 1024 * 1024
KINDS = ("image", "video", "audio", "document", "archive", "other")
EXTENSIONS = {
    "image": ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"],
    "video": ["mp4", "mov", "webm"],
    "audio": ["mp3", "m4a", "aac", "wav", "ogg", "flac"],
    "document": ["pdf", "txt", "md", "csv", "json", "docx", "xlsx", "pptx"],
    "archive": ["zip", "gz", "7z", "rar"],
}


def discovery(base):
    return {
        "supported": True,
        "contract_version": 1,
        "path": base,
        "received_files_path": base + "/files",
        "read_scope": "resources.read",
        "write_scope": "resources.write",
        "categories": [{"id": "components", "name": "构建"}, {"id": "media", "name": "影音内容"}],
        "file_kinds": list(KINDS),
        "recognized_extensions": EXTENSIONS,
        "file_sorts": ["name", "createdAt"],
        "sort_directions": ["asc", "desc"],
        "max_upload_bytes": UPLOAD_LIMIT,
        "quota_bytes": QUOTA,
        "page_size": 30,
        "max_page_size": 100,
        "max_folders": 128,
        "max_folder_depth": 8,
        "max_files": 5000,
        "upload_format": "multipart/form-data",
        "upload_name_field": "name",
        "download_auth": "cookie" if base == "/api/resource-library" else "bearer",
        "range_supported": True,
        "automatic_mutation_replay": False,
    }


def shape(raw, keys):
    if not isinstance(raw, dict) or set(raw) - set(keys):
        raise HTTPException(400, "请求字段无效")
    return raw


def category(value):
    if value not in ("components", "media"):
        raise HTTPException(400, "分类无效")
    return value


def name(value, *, folder=False):
    if (
        not isinstance(value, str)
        or not value
        or value
        != value.strip(
            "\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
        )
        or value in (".", "..")
        or len(value) > 120
        or re.search(r"[/\\\x00-\x1f\x7f]", value)
    ):
        raise HTTPException(400, "名称无效")
    try:
        if len(value.encode("utf-8")) > 240:
            raise ValueError()
    except (ValueError, UnicodeError):
        raise HTTPException(400, "名称无效") from None
    return unicodedata.normalize("NFC", value) if folder else value


def request_id(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
        return UUID(value)
    except ValueError:
        raise HTTPException(400, "requestId 必须为小写 UUID") from None


def revision(value):
    if type(value) is not int or not 1 <= value <= 9007199254740991:
        raise HTTPException(400, "版本无效")
    return value


def classify(raw, filename, cat):
    if not 1 <= len(raw) <= UPLOAD_LIMIT:
        raise HTTPException(413, "文件须为1字节至50MiB")
    ext = PurePosixPath(filename).suffix.removeprefix(".").lower()
    kind = next((k for k, values in EXTENSIONS.items() if ext in values), "other")
    mimes = dict(
        jpg="image/jpeg",
        jpeg="image/jpeg",
        png="image/png",
        gif="image/gif",
        webp="image/webp",
        heic="image/heic",
        heif="image/heif",
        mp4="video/mp4",
        mov="video/quicktime",
        webm="video/webm",
        mp3="audio/mpeg",
        m4a="audio/mp4",
        aac="audio/aac",
        wav="audio/wav",
        ogg="audio/ogg",
        flac="audio/flac",
        pdf="application/pdf",
        txt="text/plain",
        md="text/markdown",
        csv="text/csv",
        json="application/json",
        zip="application/zip",
        gz="application/gzip",
        **{
            "7z": "application/x-7z-compressed",
            "rar": "application/vnd.rar",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
    )
    zip_ok = raw[:4] in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
    ftyp = raw[4:8] == b"ftyp"
    checks = dict(
        jpg=raw[:3] == b"\xff\xd8\xff",
        jpeg=raw[:3] == b"\xff\xd8\xff",
        png=raw[:8] == b"\x89PNG\r\n\x1a\n",
        gif=raw[:6] in (b"GIF87a", b"GIF89a"),
        webp=raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
        heic=ftyp and raw[8:12] in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"),
        heif=ftyp and raw[8:12] in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"),
        mp4=ftyp,
        mov=ftyp,
        m4a=ftyp,
        webm=raw[:4] == b"\x1aE\xdf\xa3",
        mp3=raw[:3] == b"ID3" or (len(raw) > 1 and raw[0] == 255 and raw[1] & 224 == 224),
        aac=len(raw) > 1 and raw[0] == 255 and raw[1] & 246 == 240,
        wav=raw[:4] == b"RIFF" and raw[8:12] == b"WAVE",
        ogg=raw[:4] == b"OggS",
        flac=raw[:4] == b"fLaC",
        pdf=raw[:5] == b"%PDF-",
        zip=zip_ok,
        gz=raw[:2] == b"\x1f\x8b",
        docx=zip_ok,
        xlsx=zip_ok,
        pptx=zip_ok,
        **{"7z": raw[:6] == b"7z\xbc\xaf\x27\x1c", "rar": raw[:6] == b"Rar!\x1a\x07"},
    )
    valid = checks.get(ext, True)
    if ext in ("txt", "md", "csv", "json"):
        try:
            text = raw.decode("utf-8-sig")
            if "\x00" in text:
                raise ValueError()
            if ext == "json":
                json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (UnicodeError, ValueError):
            valid = False
    if not valid:
        raise HTTPException(415, "文件内容与扩展名不匹配")
    if cat == "media" and kind not in ("image", "video", "audio"):
        raise HTTPException(415, "影音分类仅接收图片、视频或音频")
    return kind, mimes.get(ext, "application/octet-stream")
