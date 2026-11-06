"""Read an already applied owner/group mapping; never fetch an old URL."""

from fastapi import HTTPException


async def legacy_reference(conn, owner, group, reference):
    installed = await (await conn.execute("SELECT to_regclass('watch_group_source_icon_links') name")).fetchone()
    if not installed['name']:
        return None
    rows = await (await conn.execute('SELECT v.* FROM watch_group_source_icon_captures c JOIN watch_group_source_icon_links l ON l.owner_id=c.owner_id AND l.capture_request_id=c.request_id JOIN watch_group_icon_versions v ON v.owner_id=l.owner_id AND v.group_id=l.target_group_id AND v.id=l.version_id WHERE c.owner_id=%s AND l.target_group_id=%s AND c.source_reference=%s ORDER BY v.created_at DESC,v.id DESC LIMIT 101', (owner, group, reference))).fetchall()
    if not rows:
        return None
    if len(rows) > 100 or len({(r['original_sha256'], r['served_sha256']) for r in rows}) != 1:
        raise HTTPException(409, '原图地址对应多个不同原件，不能猜测版本；请明确选择已核实图标')
    return rows[0]['legacy_path']+'?sha256='+rows[0]['served_sha256']
