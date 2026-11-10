"""Historical alerts and feed records keep provenance and never resume delivery jobs."""
import json
from datetime import UTC,datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from alcor_api.database_migration_personal_history import import_owned_history
from alcor_api.feed_core import post_on_connection,discussion_on_connection


async def test_owned_feed_and_alerts_retain_originals_without_enabling_old_jobs(db,admin):
    now=datetime.now(UTC);identifier=str(uuid4());task={'request_id':uuid4()}
    payload={'title':'Original article','segments':[{'text':'Original body','sourceId':'s1'}],
             'sources':[{'id':'s1','url':'https://example.com/article','title':'Original source'}]}
    selected={name:[] for name in ('price_alert_rules','feed_groups','feed_preferences','feed_group_preferences','feed_posts','feed_messages')}
    selected.update(price_alert_rules=[{'id':identifier,'config':json.dumps({'id':identifier,'name':'Original security','code':'TEST','market':'US','direction':'below','price':'7.123456','extended':True,'frequency':'once','expiresAt':None}),
        'state':'enabled','revision':'3','activated_at':'1700000000123','last_quote_at':None}],
        feed_groups=[{'id':'original','name':'Original','mode':'news','people':'[]','subscriptions':'[]','updated_at':now.isoformat()}],
        feed_preferences=[{'instructions':'Original preference','revision':'2','interval_minutes':'360','updated_at':now.isoformat()}],
        feed_posts=[{'id':'original-post','group_id':'original','fingerprint':'original-fingerprint','payload':json.dumps(payload),'kind':'news','author_key':None,'sort_at':now.isoformat(),'created_at':now.isoformat(),'liked':True,'hidden':False}],
        feed_messages=[{'id':'original-message','post_id':'original-post','role':'assistant','text':'Original archived discussion','created_at':now.isoformat()}])
    plan={'source_manifest_sha256':'a'*64}
    async with db.connection() as conn,conn.transaction():
        result=await import_owned_history(conn,SimpleNamespace(id=admin),plan,selected,task)
        assert result['price_alert_rules']==1 and result['feed_posts']==1 and not result['automatic_jobs_reactivated']
        alert=await(await conn.execute('SELECT * FROM price_alert_rules WHERE owner_id=%s AND id=%s',(admin,identifier))).fetchone()
        assert alert['state']=='paused' and alert['config']['price']=='7.123456'
        assert int(alert['activated_at'].timestamp()*1000)==1700000000123
        post=await post_on_connection(conn,admin,'original-post');assert post['title']==payload['title'] and post['liked']
        assert post['sourceEvidence']['sourceRevision']=='legacy-archive:'+'a'*64
        assert (await discussion_on_connection(conn,admin,'original-post'))[0]['text']=='Original archived discussion'
        with pytest.raises(HTTPException) as denied:await post_on_connection(conn,'another-owner','original-post')
        assert denied.value.status_code==404
        for table in ('price_alert_subscriptions','price_alert_jobs','feed_source_jobs'):
            assert (await(await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n']==0
