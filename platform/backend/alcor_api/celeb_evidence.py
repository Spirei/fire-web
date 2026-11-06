"""Revalidate retained disclosure originals without collecting or inferring positions."""
import hashlib
from uuid import uuid5

from fastapi import HTTPException

from .celeb_sec_parse import parse_xml


async def source_integrity(conn,row):
    if row['source_kind'] not in ('sec13f','secform4'):
        return {'state':'not_applicable','authority':'registered_declaration_not_verified_account'}
    unavailable={'state':'retained_unavailable','authority':'registered_declaration_source_unverified','reason':'disclosure_original_binding_unverified'}
    try:
        from .celeb_core import holding, trade
        page=await(await conn.execute('''SELECT p.*,a.target_fingerprint,a.license_revision,j.celeb_id,j.target_id,j.target_fingerprint AS job_fingerprint,j.subject,j.request_id AS parent_request_id
            FROM celeb_source_pages p JOIN celeb_source_admissions a USING(owner_id,job_id,url)
            JOIN celeb_source_jobs j ON j.owner_id=p.owner_id AND j.id=p.job_id WHERE p.id=%s AND p.owner_id=%s''',(row['source_page_id'],row['actor_id']))).fetchone()
        if not page:return unavailable
        origin=await(await conn.execute("SELECT request_id FROM celeb_revisions WHERE celeb_id=%s AND source_page_id=%s AND source_revision=%s AND raw_input->>'action'='source.ingest' ORDER BY revision LIMIT 1",(row['celeb_id'],row['source_page_id'],row['source_revision']))).fetchone()
        raw=bytes(page['raw']);evidence=row['payload'].get('sourceEvidence') or {}
        if (not page['complete'] or page['http_status']!=200 or hashlib.sha256(raw).hexdigest()!=page['raw_sha256']
                or page['celeb_id']!=row['celeb_id'] or page['target_fingerprint']!=page['job_fingerprint']
                or page['target_fingerprint']!=row['source_revision'] or evidence.get('targetId')!=page['target_id']
                or evidence.get('licenseRevision')!=page['license_revision']
                or not origin or uuid5(page['parent_request_id'],'sec-catalogue:'+page['raw_sha256'])!=origin['request_id']):return unavailable
        kind='13f' if row['source_kind']=='sec13f' else 'form4'
        parsed=parse_xml(raw,kind)
        allowed={'code','name','market','quantity','cusip','putCall','valueReported','valueUnit','sharesType','weight','weightDelta','price','cost','currency'}
        holdings=[holding({**{k:v for k,v in item.items() if k in allowed},'market':None}) for item in parsed['holdings']]
        trades=[trade({'code':item.get('code') or '', 'name':item.get('name') or '', 'market':None,'action':item.get('transactionCode') or '',
                       'quantity':item.get('quantity'),'price':item.get('price'),'date':item.get('date'),'currency':None,'sourceUrl':page['url']}) for item in parsed['trades']]
        if holdings!=row['payload']['holdings'] or trades!=row['payload']['trades'] or row['payload'].get('sourceUrl')!=page['url']:return unavailable
        # No current owner balances, quotes, estimated fees, or a reconstructed return curve.
        return {'state':'verified','authority':'verified_disclosure_original_not_owner_account','sourcePageId':str(page['id']),'sha256':page['raw_sha256']}
    except (ValueError,TypeError,KeyError,ArithmeticError,HTTPException):return unavailable
