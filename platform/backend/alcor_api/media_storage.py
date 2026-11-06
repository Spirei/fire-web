"""Private persistent media roots. Operator assets are never an unrestricted public mount."""

import asyncio
import re
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .security import Identity, administrator

router = APIRouter(prefix="/api/media", tags=["media"])
Admin = Annotated[Identity, Depends(administrator)]


def valid_asset_name(name):
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name) and ".." not in name)


def read_asset(settings, name):
    from .backups import BackupFailure, private_dir, private_read

    if settings.asset_root is None:
        raise BackupFailure("素材存储尚未配置")
    if not valid_asset_name(name):
        raise BackupFailure("素材文件名无效")
    return private_read(private_dir(settings.asset_root) / name, settings.backup_max_bytes)


@router.get(
    "/assets/{name}",
    response_class=Response,
    responses={
        200: {"content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}
    },
)
async def asset(name: str, request: Request, who: Admin):
    from .backups import BackupFailure

    if not valid_asset_name(name):
        raise HTTPException(404, "素材不存在")
    try:
        raw = await asyncio.to_thread(read_asset, request.app.state.settings, name)
    except (BackupFailure, OSError):
        raise HTTPException(404, "素材不存在或不可读取") from None
    # Do not execute operator-supplied HTML/SVG under the application's origin.
    return Response(
        raw,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"},
    )
