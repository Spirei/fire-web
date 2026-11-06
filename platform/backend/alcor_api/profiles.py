"""Self-owned profile media and a bounded projection of recorded personal activity."""

import base64
import binascii
import io
from datetime import datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

from .security import lock_mutation_identity

ZONE = ZoneInfo("Asia/Shanghai")


def normalize_avatar(value: str) -> bytes:
    try:
        header, encoded = value.split(",", 1)
        if header not in {"data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"}:
            raise ValueError()
        raw = base64.b64decode(encoded, validate=True)
        if not raw or len(raw) > 49152:
            raise ValueError()
        with Image.open(io.BytesIO(raw), formats=["PNG", "JPEG", "WEBP"]) as image:
            if image.width > 512 or image.height > 512 or getattr(image, "n_frames", 1) != 1:
                raise ValueError()
            image.load()
            crop = ImageOps.fit(ImageOps.exif_transpose(image).convert("RGBA"), (256, 256))
            clean = Image.new("RGB", crop.size, "white")
            clean.paste(crop, mask=crop.getchannel("A"))
            output = io.BytesIO()
            clean.save(output, format="JPEG", quality=85, exif=b"", icc_profile=None)
            if len(output.getvalue()) > 49152:
                raise ValueError()
            return output.getvalue()
    except (ValueError, binascii.Error, OSError, UnidentifiedImageError, Image.DecompressionBombError):
        raise HTTPException(422, "图片无法读取，请重新选择 PNG、JPEG 或 WebP 图片") from None


async def read_profile(conn, owner):
    return await (await conn.execute(
        """SELECT u.username,coalesce(p.display_name,'') AS display_name,p.revision,
        CASE WHEN p.avatar IS NOT NULL OR p.avatar_object_id IS NOT NULL THEN p.revision END AS avatar_revision
        FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=%s""", (owner,)
    )).fetchone()


async def update_profile(db, who, data, avatar, request_id):
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("profile:" + who.id,))
        await lock_mutation_identity(conn, who, require_admin=False)
        # Serialize the first insert as well as updates, including different sessions of one owner.
        return await write_profile_locked(conn, who, data, avatar, request_id)


async def write_profile_locked(conn, who, data, avatar, request_id):
    current = await read_profile(conn, who.id)
    if current["revision"] != data.revision:
        raise HTTPException(409, "资料已在其他页面修改，请重新读取后再保存")
    if "avatar_data" not in data.model_fields_set:
        old = await (
            await conn.execute("SELECT avatar FROM user_profiles WHERE user_id=%s", (who.id,))
        ).fetchone()
        avatar = old["avatar"] if old else None
    await conn.execute(
        """INSERT INTO user_profiles (user_id,display_name,avatar,revision) VALUES (%s,%s,%s,%s)
        ON CONFLICT (user_id) DO UPDATE SET display_name=excluded.display_name,avatar=excluded.avatar,
        revision=excluded.revision,updated_at=clock_timestamp()""",
        (who.id, data.display_name, avatar, uuid4()),
    )
    if "avatar_data" in data.model_fields_set:
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id,created_at) VALUES(%s,'profile.avatar.history_retired',%s,%s,clock_timestamp())",
            (who.id, who.id, request_id))
        await conn.execute("UPDATE user_profiles SET avatar_object_id=NULL WHERE user_id=%s", (who.id,))
        await conn.execute(
            "UPDATE identity_source_profiles SET metadata=jsonb_set(metadata,'{avatar}','\"\"'::jsonb) WHERE user_id=%s",
            (who.id,),
        )
    await conn.execute(
        "INSERT INTO audit_events (actor_id,action,request_id) VALUES (%s,'profile.updated',%s)",
        (who.id, request_id),
    )
    return await read_profile(conn, who.id)



async def activity(db, owner, now=None):
    now = now or datetime.now(ZONE)
    end = now.astimezone(ZONE).date()
    start = end - timedelta(days=364)
    async with db.connection() as conn, conn.transaction():
        user = await (await conn.execute("SELECT u.created_at,m.metadata FROM users u LEFT JOIN identity_source_profiles m ON m.user_id=u.id WHERE u.id=%s", (owner,))).fetchone()
        observed_since = user["created_at"].astimezone(ZONE).date()
        if user.get("metadata") and user["metadata"].get("history_started_at"):
            observed_since=max(observed_since,datetime.fromisoformat(user["metadata"]["history_started_at"]).astimezone(ZONE).date())
        rows = await (await conn.execute(
            """SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS date,
            count(*) FILTER (WHERE action='session.created') AS login,
            count(*) FILTER (WHERE action IN ('task.submitted','task.cancel_requested')) AS tasks,
            count(*) FILTER (WHERE action='profile.updated') AS profile
            FROM audit_events WHERE actor_id=%s AND created_at >= (%s::date::timestamp AT TIME ZONE 'Asia/Shanghai')
            AND created_at <= %s AND created_at >= %s
            AND action IN ('session.created','task.submitted','task.cancel_requested','profile.updated')
            GROUP BY 1 ORDER BY 1""", (owner, start, now, user["created_at"])
        )).fetchall()
    known = {r["date"]: r for r in rows}
    days = []
    day = max(start, observed_since)
    while day <= end:
        days.append(known.get(day, {"date": day, "login": 0, "tasks": 0, "profile": 0}))
        day += timedelta(days=1)
    return {"timezone": "Asia/Shanghai", "start": start, "end": end,
            "observed_since": observed_since, "observed_at": now, "days": days}
