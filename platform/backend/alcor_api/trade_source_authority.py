"""Authorize captured original bytes for ledger corrections without source I/O."""
from fastapi import HTTPException


async def lock_source_authorities(service,conn,who,expected):
    if service.authority is None:
        raise HTTPException(409,'当前服务尚未接通已归档来源授权，不能更正导入原单')
    first=next(iter(expected.values()))
    await service.authority.archive_grant(conn,who,first['grantId'],first['grantRevision'],manifest_id=first['manifestId'])
    head=await(await conn.execute('SELECT * FROM legacy_source_heads WHERE owner_id=%s FOR SHARE',(who.id,))).fetchone()
    if not head or str(head['manifest_id'])!=first['manifestId'] or head['revision']!=first['sourceRevision']:
        raise HTTPException(409,'来源清单前驱已变化，请重新读取并预览')
    current=(await(await conn.execute('SELECT source_trade_correction_authorities(%s,%s::uuid[]) value',(who.id,list(expected)))).fetchone())['value']
    if current!=expected:
        raise HTTPException(409,'原成交、授权或原现金来源已变化，请重新核对')
    return current
