"""Immutable observed metadata attached to the one public asset catalogue."""

from decimal import Decimal
from uuid import uuid5

from fastapi import HTTPException

from .asset_source_protocol import decimal
from .asset_sources import AssetSources, fingerprint


async def save(conn, db, job, asset_id, item, page, request_id):
    if job["action"] not in {"sync", "backfill"} or job["subject"]["member"]:
        raise HTTPException(403, "此任务不能发布行情元数据")
    from .asset_source_evidence import source_page
    proof,_parsed,target=await source_page(conn,db,job['owner_id'],page['id'],job_id=job['id'])
    asset = await (
        await conn.execute("SELECT type,market,code FROM asset_catalog_entries WHERE id=%s", (asset_id,))
    ).fetchone()
    if not asset or any(asset[k] != item.get(k) for k in ("type", "market", "code")):
        raise HTTPException(409, "素材元数据证券身份不一致")
    cap = decimal(item.get("marketCap"))
    if cap is not None and Decimal(cap) < 0:
        cap = None
    board = item.get("board") if isinstance(item.get("board"), str) else None
    currency = item.get("marketCapCurrency")
    if currency not in {"USD", "HKD", "CNY", "JPY", "KRW"}:
        currency = None
    identifier = uuid5(page["id"], "asset-metadata:" + asset_id)
    await conn.execute(
        "INSERT INTO asset_metadata_observations(id,asset_id,owner_id,source_page_id,target_id,target_fingerprint,license_revision,source_action,board,market_cap,market_cap_currency,source_as_of,observed_at,request_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL,%s,%s) ON CONFLICT(asset_id,owner_id,source_page_id) DO NOTHING",
        (
            identifier,
            asset_id,
            job["owner_id"],
            page["id"],
            target["id"],
            fingerprint(target),
            target["licenseRevision"],
            job["action"],
            board,
            Decimal(cap) if cap is not None else None,
            currency,
            proof["received_at"],
            request_id,
        ),
    )


async def project(conn, db, asset_id):
    row = await (
        await conn.execute(
            "SELECT * FROM asset_metadata_observations WHERE asset_id=%s ORDER BY observed_at DESC,id DESC LIMIT 1",
            (asset_id,),
        )
    ).fetchone()
    base = {
        "board": None,
        "marketCap": None,
        "marketCapCurrency": None,
        "asOf": None,
        "metadataObservation": {"state": "unknown", "authority": "licensed_provider_metadata_not_live_quote"},
    }
    if not row:
        return base
    try:
        target = AssetSources(db).target(row["owner_id"], row["target_id"], row["source_action"])
        if (
            fingerprint(target) != row["target_fingerprint"]
            or target.get("publicDisplay") is not True
            or target["licenseRevision"] != row["license_revision"]
        ):
            raise ValueError()
    except (HTTPException, ValueError, TypeError):
        base["metadataObservation"].update(state="retained_unavailable", originalsRetained=True)
        return base
    try:
        from .asset_source_evidence import source_page
        page,parsed,_target=await source_page(conn,db,row['owner_id'],row['source_page_id'])
        asset=await(await conn.execute('SELECT type,market,code FROM asset_catalog_entries WHERE id=%s',(asset_id,))).fetchone()
        matches=[item for item in parsed.get('items',[]) if asset and all(item.get(key)==asset[key] for key in ('type','market','code'))]
        if len(matches)!=1 or page['action']!=row['source_action']:
            raise ValueError('metadata_source_identity')
        item=matches[0]
        cap=decimal(item.get('marketCap'))
        cap=Decimal(cap) if cap is not None and Decimal(cap)>=0 else None
        board=item.get('board') if isinstance(item.get('board'),str) else None
        currency=item.get('marketCapCurrency') if item.get('marketCapCurrency') in {'USD','HKD','CNY','JPY','KRW'} else None
        if (row['board'],row['market_cap'],row['market_cap_currency'],row['source_as_of'])!=(board,cap,currency,None):
            raise ValueError('metadata_source_projection')
    except (HTTPException,ValueError,TypeError,KeyError):
        base['metadataObservation'].update(state='retained_unavailable',originalsRetained=True)
        return base
    return {
        "board": row["board"],
        "marketCap": format(row["market_cap"], "f") if row["market_cap"] is not None else None,
        "marketCapCurrency": row["market_cap_currency"],
        "asOf": row["source_as_of"].isoformat() if row["source_as_of"] else None,
        "metadataObservation": {
            "state": "observed",
            "authority": "licensed_provider_metadata_not_live_quote",
            "sourcePageId": str(row["source_page_id"]),
            "targetId": row["target_id"],
            "licenseRevision": row["license_revision"],
            "targetFingerprint": row["target_fingerprint"],
            "collectedAt": row["observed_at"].isoformat(),
            "sourceAsOfKnown": row["source_as_of"] is not None,
            "marketCapCurrency": row["market_cap_currency"],
        },
    }
