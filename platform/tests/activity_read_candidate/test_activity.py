"""Existing platform audit service, actual legacy TS DTO/route, and pure GET boundary."""
import hashlib
import json
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES
from alcor_api.backups import tables_and_hashes
from alcor_api.cli import create_user
from test_account_admin import login


async def hashes(db):
 async with db.connection() as conn,conn.transaction():
  result=await tables_and_hashes(conn)
 # Request accounting is independent of the business read under observation.
 telemetry = REQUEST_TELEMETRY_TABLES | {"auth_rate_limits"}
 return {name:row for name,row in result.items() if name not in telemetry}

def old(root,payload):
 result=subprocess.run(['node','--experimental-vm-modules',str(Path(__file__).with_name('run_old_activity.cjs')),str(root)],input=json.dumps(payload),text=True,capture_output=True,check=True)
 return json.loads(result.stdout)

async def test_actual_legacy_TS_store_and_route_same_platform_audit_DTO_with200_limit(client,admin,db,settings):
 from frozen_legacy import source_root
 root=source_root('ALCOR_ACTIVITY_LEGACY_ROOT',['lib/store.ts','app/api/activities/route.ts']);route=root/'app/api/activities/route.ts'
 assert hashlib.sha256(route.read_bytes()).hexdigest()=='0f7c3f96e738165cbc6b5fceb2570cfea878c6e5e36441b4dfb2885aa0520474'
 peer=await create_user(settings,'ActivityPeer','Synthetic9Pass',role='user')
 async with db.connection() as conn:
  await conn.execute("UPDATE user_profiles SET display_name='明确管理员' WHERE user_id=%s",(admin,));await conn.execute("UPDATE user_profiles SET display_name=NULL WHERE user_id=%s",(peer,))
  now=datetime.now(UTC)+timedelta(seconds=1)
  for i in range(205):await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(%s,%s,%s,%s)",(admin if i%3 else peer,'synthetic.'+str(i),'record-'+str(i),now+timedelta(milliseconds=i)))
  rows=await(await conn.execute('SELECT a.id,a.actor_id user_id,a.action event,a.target_id detail,a.created_at FROM audit_events a ORDER BY a.created_at DESC,a.id DESC')).fetchall()
  users=await(await conn.execute('SELECT u.id,u.username,p.display_name nickname FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id')).fetchall()
 payload={'users':users,'events':[dict(row,created_at=row['created_at'].isoformat(),ip=None) for row in rows],'actor':{'id':admin,'role':'admin'}}
 before=await hashes(db);response=await client.get('/api/activities');assert response.status_code==200
 expected=old(root,payload);assert expected['memoryOnly'] and expected['response']['status']==200
 assert response.json()==expected['response']['body'];assert len(response.json()['systemLogs'])==200
 assert await hashes(db)==before
 forbidden={'password_hash','token_hash','session_version','public_key','request_id'}
 assert not forbidden & set(response.json()['userLogs'][0])
 # A truthful known native username replaces the old empty-nickname JS ||'系统' bug.
 normalized=old(root,{'users':[{'id':'blank','username':'KnownUser','nickname':''}],'events':[{'id':1,'user_id':'blank','event':'login','detail':None,'ip':'198.51.100.8','created_at':'2026-01-01T00:00:00Z'}],'actor':{'id':'blank','role':'user'}})
 assert normalized['response']['body']['userLogs'][0]['userName']=='系统'
 assert normalized['response']['body']['userLogs'][0]['ip']=='198.51.100.8'

async def test_current_platform_and_legacy_Web_owner_admin_context_and_GET_never_bootstraps_business(client,admin,app,db,settings):
 peer=await create_user(settings,'ActivityPeer','Synthetic9Pass',role='user')
 async with db.connection() as conn:
  await conn.execute("INSERT INTO audit_events(actor_id,action,target_id) VALUES(%s,'synthetic.private','peer-only')",(peer,))
 personal=await login(app,'ActivityPeer')
 try:
  before=await hashes(db);result=await personal.get('/api/activities');assert result.status_code==200 and result.json()['systemLogs']==[]
  assert all(row['detail']!='peer-only' for row in (await client.get('/api/activities')).json()['userLogs'])
  assert any(row['detail']=='peer-only' for row in result.json()['userLogs']);assert await hashes(db)==before
  async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as legacy:
   authenticated=await legacy.post('/api/auth/login',json={'username':'ActivityPeer','password':'Synthetic9Pass'});assert authenticated.status_code==200,authenticated.text
   before=await hashes(db);legacy_read=await legacy.get('/api/activities');fresh_personal=await personal.get('/api/activities');assert legacy_read.status_code==fresh_personal.status_code==200 and legacy_read.json()==fresh_personal.json()
   assert await hashes(db)==before
 finally:await personal.aclose()

async def test_anonymous_cross_origin_and_explicit_bearer_do_not_expose_admin_feed(client,admin,app,db):
 # A supplied empty Authorization is malformed (401), never a cookie fallback.
 before=await hashes(db)
 for headers,status in [({'origin':'https://unapproved.example.invalid'},403),({'authorization':'Bearer unsupported'},403),({'authorization':''},401),({'x-csrf-token':'other-session-binding'},403)]:
  result=await client.get('/api/activities',headers=headers);assert result.status_code==status and result.headers.get('x-alcor-retire-context')=='true'
  if 'x-csrf-token' in headers:assert result.headers.get('x-alcor-session-changed')=='true'
 async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as anonymous:
  result=await anonymous.get('/api/activities');assert result.status_code==401 and result.headers.get('x-alcor-retire-context')=='true'
 assert await hashes(db)==before
