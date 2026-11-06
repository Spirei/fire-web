"""Global attachment references over the existing immutable private byte store."""

import asyncio

from .resource_media import LIFECYCLE, open_verified, persist


async def media_inventory(conn, limit=None):
    tables = []
    for name in ("resource_media_objects", "admin_attachment_objects"):
        row = await (await conn.execute("SELECT to_regclass(%s) relation", ("public." + name,))).fetchone()
        if row["relation"]:
            tables.append("SELECT sha256,byte_length FROM " + name)
    if not tables:
        return []
    query = (
        "SELECT sha256,min(byte_length) size,max(byte_length) max_size FROM ("
        + " UNION ALL ".join(tables)
        + ") objects GROUP BY sha256 ORDER BY sha256"
    )
    return await (
        await conn.execute(query + (" LIMIT %s" if limit else ""), (limit,) if limit else ())
    ).fetchall()


async def media_referenced(conn, digest):
    for name in ("resource_media_objects", "admin_attachment_objects"):
        table = await (await conn.execute("SELECT to_regclass(%s) relation", ("public." + name,))).fetchone()
        if (
            table["relation"]
            and await (
                await conn.execute("SELECT 1 FROM " + name + " WHERE sha256=%s LIMIT 1", (digest,))
            ).fetchone()
        ):
            return True
    return False


async def stage(conn, settings, digest, raw):
    await conn.execute("SELECT pg_advisory_xact_lock_shared(" + LIFECYCLE + ")")
    await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("resource-sha:" + digest,))
    # Same O_EXCL/O_NOFOLLOW, integrity, fsync-file+directory boundary as F26.
    # A failed/uncertain PG commit never unlinks another committed reference.
    await asyncio.to_thread(persist, settings, digest, raw)
    await conn.execute(
        "INSERT INTO admin_attachment_objects(sha256,byte_length) VALUES(%s,%s) ON CONFLICT(sha256) DO NOTHING",
        (digest, len(raw)),
    )


async def open_original(settings, row):
    return await asyncio.to_thread(open_verified, settings, row["sha256"], row["byte_length"])
