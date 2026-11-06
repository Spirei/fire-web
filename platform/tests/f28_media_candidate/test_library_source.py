"""Actual old SQLite paging runs only in memory; unknown caps explicitly remain unknown."""
import asyncio
import json
import subprocess
from pathlib import Path

from test_asset_catalog_management import command
from frozen_legacy import source_root


async def test_attachment_library_matches_actual_old_query_fields_and_literal_ascii_paging(client,admin):
    values=[('A','Name%literal'),('B','Name_under'),('C','ΓREEK')]
    rows=[]
    for index,(code,name) in enumerate(values):
        response=await client.post('/api/admin/asset-catalog/entries',json=command(revision=index,code=code,name=name))
        assert response.status_code==200,response.text
        rows.append({'id':response.json()['asset']['id'],'type':'stock','market':'US','code':code,'name':name})
    queries=[{'type':'stock','sort':'code','pageSize':2.9,'page':1},{'type':'stock','sort':'code','q':'_','pageSize':100},{'type':'stock','sort':'code','page':2.9},{'type':'stock','sort':'code','page':16,'pageSize':1}]
    output=await asyncio.to_thread(subprocess.check_output,['node',str(Path(__file__).with_name('library_source.cjs')),str(source_root('ALCOR_MARKET_LEGACY_ROOT', ['lib/attachments.ts']))],input=json.dumps({'rows':rows,'queries':queries}),text=True)
    golden=json.loads(output)
    for query,old in zip(queries,golden,strict=True):
        response=await client.get('/api/attachments/library',params={'paged':'1',**query})
        assert response.status_code==200,response.text
        new=response.json()
        assert {key:new[key] for key in ('page','pageSize','total','totalAll','markets')}=={key:old[key] for key in ('page','pageSize','total','totalAll','markets')}
        assert [{key:r[key] for key in ('id','type','market','code','name','url','board')} for r in new['items']]==[{key:r[key] for key in ('id','type','market','code','name','url','board')} for r in old['items']]
        assert all(row['marketCap'] is None for row in new['items']) and all(row['marketCap']==0 for row in old['items'])
        assert new['counts']=={'stock':3,'crypto':0,'metal':0,'market':0} and old['counts']=={'stock':3}
