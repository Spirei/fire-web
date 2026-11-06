"""Minimal file tombstones referencing the existing immutable F32 source-owner authority."""

from fastapi import HTTPException


async def check_file_claim(conn, grant, root_identity, original_id, *, required=False):
    rows = await (
        await conn.execute(
            "SELECT * FROM personal_font_source_file_claims WHERE original_id=%s AND (root_identity=%s OR source_instance=%s OR physical_identity_hash=%s) FOR SHARE",
            (original_id, root_identity, grant["source_instance"], grant["physical_identity_hash"]),
        )
    ).fetchall()
    if any(
        row["owner_id"] != grant["owner_id"]
        or row["source_owner"] != grant["source_owner"]
        or row["source_instance"] != grant["source_instance"]
        or row["physical_identity_hash"] != grant["physical_identity_hash"]
        or row["root_identity"] != root_identity
        for row in rows
    ):
        raise HTTPException(409, "此旧字体已有永久来源归属；关闭账号、换别名或换目标不会转让原文件")
    if (
        not rows
        and await (
            await conn.execute(
                "SELECT 1 FROM personal_font_source_history_gaps WHERE physical_identity_hash=%s",
                (grant["physical_identity_hash"],),
            )
        ).fetchone()
    ):
        raise HTTPException(
            409, "旧来源存在账号关闭前的字体归属历史缺口（history_gap）；不能重新分配未知原文件"
        )
    if required and len(rows) != 1:
        raise HTTPException(409, "缺少同一来源与本人的永久字体归属，不能继续导入")
    return rows


async def bind_file_claim(conn, permission):
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
        ("font-source-file:" + permission["root_identity"] + ":" + permission["original_id"],),
    )
    rows = await check_file_claim(conn, permission, permission["root_identity"], permission["original_id"])
    if not rows:
        await conn.execute(
            "INSERT INTO personal_font_source_file_claims(root_identity,original_id,source_instance,source_owner,owner_id,physical_identity_hash,first_grant_id) VALUES(%s,%s,%s,%s,%s,%s,%s)",
            (
                permission["root_identity"],
                permission["original_id"],
                permission["source_instance"],
                permission["source_owner"],
                permission["owner_id"],
                permission["physical_identity_hash"],
                permission["grant_id"],
            ),
        )
    await check_file_claim(
        conn, permission, permission["root_identity"], permission["original_id"], required=True
    )
