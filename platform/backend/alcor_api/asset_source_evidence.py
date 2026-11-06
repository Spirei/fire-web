"""Reparse retained public-catalogue evidence under current owner and source permission."""
import hashlib
import json
from functools import lru_cache

from fastapi import HTTPException

from .asset_source_protocol import Request, parse, validate_request
from .asset_sources import AssetSources, fingerprint


@lru_cache(maxsize=4)
def decoded(raw,request_json):
    return parse(raw,Request(**json.loads(request_json)))


async def source_page(conn,db,owner,page_id,*,job_id=None):
    row=await(await conn.execute('''SELECT p.*,a.request,a.target_fingerprint AS admitted_fingerprint,a.license_revision,
        j.target_id,j.target_fingerprint,j.action,j.subject,j.inputs FROM asset_source_pages p
        JOIN asset_source_admissions a ON a.owner_id=p.owner_id AND a.job_id=p.job_id AND a.request_key=p.request_key
        JOIN asset_source_jobs j ON j.owner_id=p.owner_id AND j.id=p.job_id WHERE p.owner_id=%s AND p.id=%s''',(owner,page_id))).fetchone()
    if not row or job_id is not None and row['job_id']!=job_id:
        raise HTTPException(503,'素材来源原件绑定缺失')
    choices={item['id']:item for item in [{'id':row['target_id'],'fingerprint':row['target_fingerprint']},*row['inputs'].get('listTargets',[])] if item['fingerprint']==row['admitted_fingerprint']}
    if len(choices)!=1:raise HTTPException(503,'素材来源页不属于原许可图')
    selected=next(iter(choices.values()))
    target=AssetSources(db).target(owner,selected['id'],row['action'],member=row['subject']['member'])
    actor=await(await conn.execute('SELECT role FROM users WHERE id=%s AND active AND deleted_at IS NULL',(owner,))).fetchone()
    licensor=await(await conn.execute('SELECT 1 FROM users WHERE id=%s AND active AND deleted_at IS NULL',(target['ownerId'],))).fetchone()
    if not actor or not licensor or not row['subject']['member'] and actor['role']!='admin':
        raise HTTPException(503,'素材来源当前授权主体不可用')
    if (row['subject']['instanceId']!=str(db.settings.instance_id) or selected['fingerprint']!=fingerprint(target)
            or row['admitted_fingerprint']!=fingerprint(target) or row['license_revision']!=target['licenseRevision']):
        raise HTTPException(503,'素材来源当前许可或实例已变化')
    raw=bytes(row['raw'])
    request=Request(**row['request'])
    validate_request(target,request)
    if (not row['complete'] or row['http_status']!=200 or row['representation']!=request.representation
            or hashlib.sha256(raw).hexdigest()!=row['raw_sha256']):
        raise HTTPException(503,'素材来源原件完整性不可验证')
    return row,decoded(raw,json.dumps(row['request'],sort_keys=True)),target


async def historical_identity(conn,job,page_id,asset):
    """A historical creation fact, not permission to collect or display source metadata."""
    row=await(await conn.execute('''SELECT p.*,a.request,a.target_fingerprint,a.license_revision
        FROM asset_source_pages p JOIN asset_source_admissions a ON a.owner_id=p.owner_id AND a.job_id=p.job_id AND a.request_key=p.request_key
        WHERE p.owner_id=%s AND p.job_id=%s AND p.id=%s''',(job['owner_id'],job['id'],page_id))).fetchone()
    permitted={job['target_fingerprint'],*(entry['fingerprint'] for entry in [*job['inputs'].get('iconTargets',[]),*job['inputs'].get('listTargets',[])])}
    if not row or row['target_fingerprint'] not in permitted or not row['license_revision'] or not row['complete'] or row['http_status']!=200:
        return False
    raw=bytes(row['raw'])
    if hashlib.sha256(raw).hexdigest()!=row['raw_sha256']:return False
    request=Request(**row['request'])
    if row['representation']!=request.representation:return False
    if request.representation=='image_http_response_body':
        return all(request.context.get(key)==asset[key] for key in ('market','code'))
    parsed=decoded(raw,json.dumps(row['request'],sort_keys=True))
    return any(all(item.get(key)==asset[key] for key in ('type','market','code')) for item in parsed.get('items',[]))


async def creation_origin(conn,asset):
    """The first creation and exact original child receipt decide origin, never later metadata."""
    from uuid import uuid5
    event=await(await conn.execute("SELECT e.* FROM asset_catalog_management_events e WHERE asset_id=%s AND before_snapshot IS NULL AND kind='upsert' ORDER BY created_at,id LIMIT 1",(asset['id'],))).fetchone()
    unknown={'source':'unknown','sourceKnown':False,'creationAuthority':'unverified_creation_chain'}
    if not event or not event['after_snapshot'] or event['after_snapshot'].get('id')!=asset['id']:
        return unknown
    receipt=await(await conn.execute('SELECT result FROM asset_catalog_operations WHERE actor_id=%s AND request_id=%s',(event['actor_id'],event['request_id']))).fetchone()
    if not receipt or receipt['result']!=event['result'] or receipt['result'].get('asset')!=event['after_snapshot']:
        return unknown
    source=event['after_snapshot'].get('source')
    if source=='manual':
        return {'source':'manual','sourceKnown':True,'creationAuthority':'explicit_manual_registration'}
    if source!='auto':return unknown
    jobs=await(await conn.execute("SELECT * FROM asset_source_jobs j WHERE owner_id=%s AND action IN ('sync','add') AND result IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.result->'operations','[]'::jsonb)) op WHERE op->>'requestId'=%s)",(event['actor_id'],str(event['request_id'])))).fetchall()
    for job in jobs:
        for index,operation in enumerate(job['result'].get('operations',[])):
            if operation.get('requestId')!=str(event['request_id']):continue
            if (operation.get('creationOrigin')!='auto' or uuid5(job['request_id'],'asset-write:'+str(index)+':'+asset['id'])!=event['request_id']
                    or any(operation.get(key)!=value for key,value in event['result'].items())
                    or job['action']=='add' and job['inputs']['options'].get('onlyIfMissing') is not True and not job['subject']['member']):
                return unknown
            try:
                if any([await historical_identity(conn,job,pid,asset) for pid in job['result'].get('sourcePageIds',[])]):
                    return {'source':'auto','sourceKnown':True,'creationAuthority':'bound_automatic_creation_receipt','creationRequestId':str(job['request_id'])}
            except (HTTPException,ValueError,TypeError,KeyError):return unknown
    return unknown
