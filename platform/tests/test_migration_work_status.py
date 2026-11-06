"""Only an administrator can read the tiny, non-writing publisher sidecar."""
import json
from datetime import UTC, datetime, timedelta

from alcor_api.cli import create_user

PATH='/api/system/migration/work-status'


def payload(**changes):
    return {'schema_version':1,'state':'working','feature_id':'F15','step':'核对来源','summary':'核对最新报价',
            'updated_at':datetime.now(UTC).isoformat(),'sequence':3,**changes}


async def test_status_permissions_missing_and_no_source_writes(client, settings, tmp_path):
    settings.inventory_file=tmp_path/'inventory.json'
    assert (await client.get(PATH)).status_code==401
    await create_user(settings,'reader','Synthetic9Pass',role='user')
    logged=await client.post('/api/session/login',json={'login':'reader','password':'Synthetic9Pass'})
    client.headers['x-csrf-token']=logged.json()['csrf']
    assert (await client.get(PATH)).status_code==403
    await create_user(settings,'manager','Synthetic9Pass',role='admin')
    logged=await client.post('/api/session/login',json={'login':'manager','password':'Synthetic9Pass'})
    client.headers['x-csrf-token']=logged.json()['csrf']
    before=set(tmp_path.iterdir())
    response=await client.get(PATH)
    assert response.status_code==200 and response.json()['state']=='unknown'
    assert 'no-store' in response.headers['cache-control']
    assert set(tmp_path.iterdir())==before
    assert (await client.post(PATH,json={})).status_code==404


async def test_status_valid_stale_invalid_and_bounded_reads(client, admin, settings, tmp_path):
    settings.inventory_file=tmp_path/'inventory.json'
    settings.inventory_file.write_bytes(b'not a register; this endpoint never reads it')
    sidecar=tmp_path/'migration-work-status.json'
    good=payload(source_commit='abc1234')
    sidecar.write_text(json.dumps(good));before=sidecar.read_bytes()
    first=await client.get(PATH)
    assert first.json()['state']=='working' and first.json()['sourceCommit']=='abc1234'
    assert first.json()['updatedAt']==good['updated_at'] and not first.json()['stale']
    assert sidecar.read_bytes()==before
    stale=payload(updated_at=(datetime.now(UTC)-timedelta(seconds=121)).isoformat())
    sidecar.write_text(json.dumps(stale))
    result=(await client.get(PATH)).json()
    assert result['stale'] and result['updatedAt']==stale['updated_at']
    invalid=[b'{broken',b'x'*16385,json.dumps(payload(updated_at=(datetime.now(UTC)+timedelta(seconds=6)).isoformat())).encode(),
             json.dumps(payload(summary='/private/local/file')).encode(),json.dumps(payload(token='private')).encode(),
             json.dumps(payload(sequence=True)).encode(),json.dumps(payload(updated_at='2026-11-03T10:00:00')).encode()]
    for content in invalid:
        sidecar.write_bytes(content)
        result=await client.get(PATH)
        assert result.status_code==200 and result.json()['state']=='unknown'
        assert sidecar.read_bytes()==content
    assert settings.inventory_file.read_bytes()==b'not a register; this endpoint never reads it'
