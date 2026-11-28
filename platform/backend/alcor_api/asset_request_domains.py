"""Check an existing financial UUID before touching entries in another domain.

The owner transaction lock remains held through effects and the immutable receipt.
Database receipt triggers provide the final cross-domain reservation and rollback.
"""

from fastapi import HTTPException


async def require_domain(conn, owner, request_id, domain):
    row = await (await conn.execute("""
        SELECT (SELECT domain FROM broker_request_domains WHERE owner_id=%s AND request_id=%s) AS broker,
               (SELECT domain FROM asset_request_domains WHERE owner_id=%s AND request_id=%s) AS asset
    """, (owner, request_id, owner, request_id))).fetchone()
    check_domains(row['broker'], row['asset'], domain)


def check_domains(broker, asset, domain):
    if broker not in (None, 'asset'):
        raise HTTPException(409, '原UUID已用于其他账户操作，请查询原回执')
    if asset not in (None, domain):
        raise HTTPException(409, '原UUID已用于其他资金或证券操作，请查询原回执')
