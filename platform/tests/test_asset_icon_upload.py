import asyncio
from uuid import uuid4

import pytest_asyncio

from test_legacy_asset_directory import SVG, write

P = "/api/admin/shared-assets"

@pytest_asyncio.fixture(autouse=True)
async def files(settings, tmp_path):
    settings.file_root=tmp_path/"uploads"
    write(settings.file_root,"asset/stock/US/DEMO.svg")
    write(settings.file_root,"asset/flag/US.svg")
    settings.file_root.chmod(0o700)

async def body(client, asset=None, revision=None, catalog_revision=0, identifier=None):
    scope=(await client.get(P)).json()
    return {"kind":"asset","folder":"stock","market":"US","code":"DEMO","name":"Synthetic icon", "assetId":"stock:US:DEMO","requestId":identifier or str(uuid4()),"expectedRevision":str(scope["revision"] if revision is None else revision),"catalogRevision":str(catalog_revision),"publicMetadataConfirmed":"true",**(asset or {})}

async def send(client, data, raw=SVG):
    return await client.post(P+"/upload",data=data,files={"file":("image.svg",raw,"image/svg+xml")})

async def test_camera_upload_atomically_registers_target_and_replays_one_uuid(client,admin,db,settings):
    data=await body(client)
    responses=await asyncio.gather(*(send(client,data,SVG.replace(b"M0 0",b"M1 1")) for _ in range(2)))
    assert all(r.status_code==200 for r in responses),[r.text for r in responses]
    one=responses[0].json()
    assert all(r.json()==one for r in responses)
    assert one["binding"]=={"id":"stock:US:DEMO","type":"stock","market":"US","code":"DEMO","revision":1,"imageVersion":one["version"]}
    listing=(await client.get("/api/assets?type=stock&paged=1")).json()
    assert listing["total"]==1 and listing["assets"][0]["imageVersion"]==one["version"]
    assert (await client.get(listing["assets"][0]["imageUrl"])).status_code==200
    assert (settings.file_root/"asset/stock/US/DEMO.svg").read_bytes()==SVG
    assert (await client.get(P+"/operations/"+data["requestId"])).json()==one
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM system_asset_versions")).fetchone())["n"]==1
        assert (await (await conn.execute("SELECT count(*) n FROM asset_catalog_entries")).fetchone())["n"]==1

async def test_conflict_rolls_back_upload_and_catalog_together(client,admin,db):
    data=await body(client,catalog_revision=10)
    rejected=await send(client,data)
    assert rejected.status_code==409,rejected.text
    result=(await client.get(P+"/operations/"+data["requestId"])).json()
    assert result["state"]=="failed" and result["revision"]==0 and "version" not in result
    async with db.connection() as conn:
        for table in ["system_asset_versions","asset_catalog_entries"]:
            assert (await (await conn.execute("SELECT count(*) n FROM "+table)).fetchone())["n"]==0
        assert (await (await conn.execute("SELECT revision FROM asset_catalog_scope")).fetchone())["revision"]==0

async def test_flag_upload_suppresses_filename_alias_and_keeps_original(client,admin,settings):
    data=await body(client,{"folder":"flag","market":"","code":"US","name":"Example flag","assetId":"flag:US"})
    response=await send(client,data)
    assert response.status_code==200,response.text
    assert response.json()["binding"]["market"]=="OTHER"
    listing=(await client.get("/api/assets?type=flag&paged=1")).json()
    assert listing["total"]==1
    assert (settings.file_root/"asset/flag/US.svg").read_bytes()==SVG

async def test_binding_requires_admin_csrf_and_complete_fields(client,admin):
    data=await body(client)
    data.pop("publicMetadataConfirmed")
    assert (await send(client,data)).status_code==400
    client.headers.pop("x-csrf-token")
    assert (await send(client,await body(client))).status_code==403
