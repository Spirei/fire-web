"""Owner-isolated feed originals, preferences and explicit discussion records."""

import base64
import hashlib
import ipaddress
import json
import re
from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .account_signals import guard
from .native_app_auth import CLIENT

ICONS={'market','chart','world','technology','idea','note','security','time','conversation','magic','image','palette','check'}
PEOPLE=['trump','duan']


def stamp(value):return value.isoformat().replace('+00:00','Z') if value else None


def text(value,maximum,*,empty=False):
    if not isinstance(value,str) or len(value.encode('utf-16-le'))//2>maximum or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',value):raise HTTPException(400,'动态文字无效')
    result=value.strip()
    if not result and not empty:raise HTTPException(400,'请填写内容')
    return result


def revision(value):
    if type(value) is not int or not 0<=value<=9007199254740991:raise HTTPException(400,'请提供当前版本')
    return value


def source_url(value):
    try:
        if not isinstance(value,str) or len(value)>2048 or re.search(r'[\x00-\x20\x7f]',value):raise ValueError()
        parsed=urlsplit(value)
        host=parsed.hostname or ''
        if parsed.scheme!='https' or parsed.username or parsed.password or parsed.port not in (None,443) or '.' not in host or host.endswith(('.local','.localhost','.internal')) or host in ('localhost',):raise ValueError()
        try:
            address=ipaddress.ip_address(host)
            if not address.is_global:raise ValueError()
        except ValueError:
            if re.fullmatch(r'[0-9.]+',host) or ':' in host:raise
        return urlunsplit((parsed.scheme,parsed.netloc,parsed.path or '/',parsed.query,''))
    except (ValueError,TypeError):raise HTTPException(400,'仅允许公开HTTPS来源地址') from None


def subscriptions(raw):
    if not isinstance(raw,list) or len(raw)>8:raise HTTPException(400,'每组最多8个订阅源')
    values=[];seen=set()
    for item in raw:
        if not isinstance(item,dict) or set(item)!={'name','url'}:raise HTTPException(400,'订阅内容无效')
        url=source_url(item['url'])
        if url in seen:raise HTTPException(400,'订阅地址重复')
        seen.add(url);values.append({'name':text(item['name'],60),'url':url})
    return values


async def authorize(conn,who,write=False):
    if getattr(who,'legacy_client',False) and not getattr(who,'native_client',False):
        # Original v1 Web identity is local to this domain, not a global sync grant.
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
        from .security import lock_mutation_identity
        await lock_mutation_identity(conn,who,require_admin=False)
        current=await(await conn.execute('SELECT role FROM users WHERE id=%s',(who.id,))).fetchone()
        if not current or current['role']!=who.role:raise HTTPException(403,'账号权限已变化')
    else:
        await guard(conn,who,'feed.write' if write else 'feed.read')
    if getattr(who,'native_client',False):
        row=await(await conn.execute('SELECT client_id FROM identity_app_grants WHERE id=%s',(who.grant_id,))).fetchone()
        if not row or row['client_id']!=CLIENT:raise HTTPException(401,'连接已失效')


async def group_on_connection(conn,owner,group_id='default'):
    if group_id!='default' and (not isinstance(group_id,str) or not re.fullmatch(r'fg-[a-f0-9]{24}',group_id)):raise HTTPException(404,'动态组不存在')
    row=await(await conn.execute('SELECT * FROM feed_groups WHERE owner_id=%s AND id=%s',(owner,group_id))).fetchone()
    if not row and group_id!='default':raise HTTPException(404,'动态组不存在')
    preferences=await preferences_on_connection(conn,owner,group_id)
    return {'id':group_id,'name':row['name'] if row else '动态','subscriptions':row['subscriptions'] if row else [],'mode':row['mode'] if row else 'news','people':row['people'] if row else PEOPLE[:],'updatedAt':stamp(row['updated_at']) if row else None,'revision':preferences['revision']}


async def preferences_on_connection(conn,owner,group_id='default'):
    if group_id=='default':row=await(await conn.execute('SELECT * FROM feed_preferences WHERE owner_id=%s',(owner,))).fetchone()
    else:row=await(await conn.execute('SELECT * FROM feed_group_preferences WHERE owner_id=%s AND group_id=%s',(owner,group_id))).fetchone()
    return {'instructions':row['instructions'] if row else '','revision':row['revision'] if row else 0,'enabled':row['enabled'] if row else False,'intervalMinutes':row['interval_minutes'] if row else 360,'updatedAt':stamp(row['updated_at']) if row else None}


async def profile_on_connection(conn,owner):
    row=await(await conn.execute('SELECT * FROM feed_agent_profiles WHERE owner_id=%s',(owner,))).fetchone()
    return {'name':row['name'] if row else 'Alcor','image':row['image'] if row else None,'revision':row['revision'] if row else 0,'updatedAt':stamp(row['updated_at']) if row else None}


async def groups_on_connection(conn,owner):
    rows=await(await conn.execute("SELECT id FROM feed_groups WHERE owner_id=%s AND id<>'default' ORDER BY updated_at,id LIMIT 13",(owner,))).fetchall()
    if len(rows)>11:raise HTTPException(409,'动态组超出读取范围')
    return [await group_on_connection(conn,owner)]+[await group_on_connection(conn,owner,row['id']) for row in rows]


def post_dto(row):
    return {**row['payload'],'id':row['id'],'createdAt':stamp(row['created_at']),'liked':bool(row.get('liked',False)),'hidden':bool(row.get('hidden',False)),'revision':row.get('mark_revision',0),
            'sourceEvidence':{'sourceRevision':row['source_revision'],'pageId':row['source_page_id'],'contentImmutable':True}}


async def post_on_connection(conn,owner,post_id):
    row=await(await conn.execute('SELECT p.*,COALESCE(m.liked,false) AS liked,COALESCE(m.hidden,false) AS hidden,COALESCE(m.revision,0) AS mark_revision FROM feed_posts p LEFT JOIN feed_post_marks m ON m.owner_id=p.owner_id AND m.post_id=p.id WHERE p.owner_id=%s AND p.id=%s',(owner,post_id))).fetchone()
    if not row:raise HTTPException(404,'动态不存在')
    return post_dto(row)


async def discussion_on_connection(conn,owner,post_id):
    await post_on_connection(conn,owner,post_id)
    rows=await(await conn.execute('SELECT id,role,text,created_at,source_revision,source_page_id FROM (SELECT * FROM feed_messages WHERE owner_id=%s AND post_id=%s ORDER BY created_at DESC,id DESC LIMIT 40) x ORDER BY created_at,id',(owner,post_id))).fetchall()
    return [{'id':row['id'],'role':row['role'],'text':row['text'],'createdAt':stamp(row['created_at']),'sourceEvidence':{'sourceRevision':row['source_revision'],'pageId':row['source_page_id']} if row['role']=='assistant' else None} for row in rows]


class FeedService:
    def __init__(self,db):self.db=db

    async def groups(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await authorize(conn,who)
            return {'groups':await groups_on_connection(conn,who.id)}

    async def group(self,who,group_id='default'):
        async with self.db.connection() as conn,conn.transaction():
            await authorize(conn,who)
            return await group_on_connection(conn,who.id,group_id)

    async def profile(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await authorize(conn,who)
            return await profile_on_connection(conn,who.id)

    async def preferences(self,who,group_id='default'):
        async with self.db.connection() as conn,conn.transaction():
            await authorize(conn,who)
            await group_on_connection(conn,who.id,group_id)
            return await preferences_on_connection(conn,who.id,group_id)

    async def post(self,who,post_id):
        async with self.db.connection() as conn,conn.transaction():
            await authorize(conn,who)
            return await post_on_connection(conn,who.id,post_id)

    async def discussion(self,who,post_id):
        async with self.db.connection() as conn,conn.transaction():
            await authorize(conn,who)
            return {'messages':await discussion_on_connection(conn,who.id,post_id)}

    async def list(self,who,*,cursor=None,limit=10,group_id='default',author=None,include_hidden=False):
        if type(include_hidden) is not bool:raise HTTPException(400,'隐藏动态筛选无效')
        if type(limit) is not int or not 1<=limit<=50:raise HTTPException(400,'每页条数为1–50')
        cursor_time=None;cursor_id=None
        if cursor:
            try:
                if not isinstance(cursor,str) or len(cursor)>256:raise ValueError()
                decoded=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
                if not isinstance(decoded,list) or len(decoded)!=2 or not isinstance(decoded[0],str) or not re.fullmatch(r'fp-[a-f0-9]{24}',decoded[1]):raise ValueError()
                cursor_time=datetime.fromisoformat(decoded[0]);cursor_id=decoded[1]
                if cursor_time.tzinfo is None:raise ValueError()
            except (ValueError,TypeError,UnicodeError):raise HTTPException(400,'分页游标无效') from None
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await authorize(conn,who)
            group=await group_on_connection(conn,who.id,group_id)
            if author and (group['mode']!='people' or author not in group['people']):raise HTTPException(400,'人物筛选无效')
            rows=await(await conn.execute('''SELECT p.*,COALESCE(m.liked,false) AS liked,COALESCE(m.hidden,false) AS hidden,COALESCE(m.revision,0) AS mark_revision
             FROM feed_posts p LEFT JOIN feed_post_marks m ON m.owner_id=p.owner_id AND m.post_id=p.id
             WHERE p.owner_id=%s AND p.group_id=%s AND p.kind=%s AND (%s OR NOT COALESCE(m.hidden,false))
             AND (%s='news' OR p.author_key=ANY(%s)) AND (%s::text IS NULL OR p.author_key=%s)
             AND (%s::timestamptz IS NULL OR (p.sort_at,p.id)<(%s::timestamptz,%s::text)) ORDER BY p.sort_at DESC,p.id DESC LIMIT %s''',
             (who.id,group_id,group['mode'],include_hidden,group['mode'],group['people'],author,author,cursor_time,cursor_time,cursor_id,limit+1))).fetchall()
            selected=rows[:limit];last=selected[-1] if selected else None
            next_cursor=base64.urlsafe_b64encode(json.dumps([stamp(last['sort_at']),last['id']],separators=(',',':')).encode()).decode().rstrip('=') if len(rows)>limit and last else None
            return {'agent':await profile_on_connection(conn,who.id),'posts':[post_dto(row) for row in selected],'nextCursor':next_cursor,
                    'preferences':await preferences_on_connection(conn,who.id,group_id),'group':group,'groups':await groups_on_connection(conn,who.id),'job':None,
                    'capabilities':{'generate':False,'search':'news-rss','avatar':{'image':'stored_profile_only','video':None}},
                    'sourceState':'stored_observations_only','collectionOnRead':False}

    async def receipt(self,who,request_id):
        try:request_id=str(UUID(request_id))
        except (ValueError,TypeError):raise HTTPException(400,'请求编号无效') from None
        async with self.db.connection() as conn,conn.transaction():
            await authorize(conn,who)
            row=await(await conn.execute('SELECT result FROM feed_operations WHERE owner_id=%s AND request_id=%s',(who.id,request_id))).fetchone()
            if not row:raise HTTPException(404,'原请求回执尚未找到')
            return row['result']

    async def mutate(self,who,request_id,action,raw,*,group_id='default',post_id=None):
        try:request_id=str(UUID(request_id))
        except (ValueError,TypeError):raise HTTPException(400,'请求编号无效') from None
        if not isinstance(raw,dict):raise HTTPException(400,'动态修改无效')
        try:encoded=json.dumps({'action':action,'group':group_id,'post':post_id,'raw':raw},sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False)
        except (ValueError,TypeError,UnicodeError):raise HTTPException(400,'动态修改无效') from None
        if len(encoded.encode())>20000:raise HTTPException(413,'内容过长')
        hashed=hashlib.sha256(encoded.encode()).hexdigest()
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
            await authorize(conn,who,True)
            prior=await(await conn.execute('SELECT fingerprint,result FROM feed_operations WHERE owner_id=%s AND request_id=%s',(who.id,request_id))).fetchone()
            if prior:
                if prior['fingerprint']!=hashed:raise HTTPException(409,'请求编号已用于其他修改')
                return prior['result']
            before=None
            if action=='group.create':
                if set(raw)-{'name','mode','people'}:raise HTTPException(400,'动态组内容无效')
                if len(await groups_on_connection(conn,who.id))>=12:raise HTTPException(400,'每个账号最多12个动态组')
                name=text(raw.get('name'),40);mode=raw.get('mode','news');people=raw.get('people',PEOPLE[:]);validate_mode(mode,people)
                group_id='fg-'+uuid5(UUID(request_id),'feed-group:'+who.id).hex[:24]
                await conn.execute('INSERT INTO feed_groups(owner_id,id,name,mode,people) VALUES(%s,%s,%s,%s,%s)',(who.id,group_id,name,mode,Jsonb(people)))
                if mode=='people':await conn.execute('INSERT INTO feed_group_preferences(owner_id,group_id,revision,enabled,interval_minutes) VALUES(%s,%s,1,true,5)',(who.id,group_id))
                outcome=await group_on_connection(conn,who.id,group_id)
            elif action in ('preferences','group.rename'):
                group=await group_on_connection(conn,who.id,group_id);current=await preferences_on_connection(conn,who.id,group_id);before={'group':group,'preferences':current}
                if action=='group.rename':
                    if set(raw)!={'name','revision'}:raise HTTPException(400,'请填写名称及版本')
                    raw={**current,**raw};raw.pop('updatedAt',None)
                if set(raw)-{'instructions','revision','enabled','intervalMinutes','name','subscriptions','mode','people'}:raise HTTPException(400,'指示内容无效')
                if revision(raw.get('revision'))!=current['revision']:raise HTTPException(409,'指示已在另一端修改，请重新读取')
                mode=raw.get('mode',group['mode']);people=raw.get('people',group['people']);validate_mode(mode,people)
                instructions=text(raw.get('instructions'),4000,empty=True);name=text(raw.get('name',group['name']),40)
                enabled=raw.get('enabled',True)
                if type(enabled) is not bool:raise HTTPException(400,'自动更新选项无效')
                interval=raw.get('intervalMinutes',5 if mode=='people' and mode!=group['mode'] else 360 if mode!=group['mode'] else current['intervalMinutes'])
                if type(interval) is not int or not (5 if mode=='people' else 60)<=interval<=1440:raise HTTPException(400,'更新间隔无效')
                sources=subscriptions(raw['subscriptions']) if 'subscriptions' in raw else group['subscriptions']
                await conn.execute('''INSERT INTO feed_groups(owner_id,id,name,subscriptions,mode,people) VALUES(%s,%s,%s,%s,%s,%s)
                 ON CONFLICT(owner_id,id) DO UPDATE SET name=excluded.name,subscriptions=excluded.subscriptions,mode=excluded.mode,people=excluded.people,updated_at=clock_timestamp()''',
                 (who.id,group_id,name,Jsonb(sources),mode,Jsonb(people)))
                active=enabled and bool(mode=='people' or instructions)
                if group_id=='default':
                    await conn.execute('''INSERT INTO feed_preferences(owner_id,instructions,revision,enabled,interval_minutes) VALUES(%s,%s,%s,%s,%s)
                     ON CONFLICT(owner_id) DO UPDATE SET instructions=excluded.instructions,revision=excluded.revision,enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,updated_at=clock_timestamp()''',(who.id,instructions,current['revision']+1,active,interval))
                else:
                    await conn.execute('''INSERT INTO feed_group_preferences(owner_id,group_id,instructions,revision,enabled,interval_minutes) VALUES(%s,%s,%s,%s,%s,%s)
                     ON CONFLICT(owner_id,group_id) DO UPDATE SET instructions=excluded.instructions,revision=excluded.revision,enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,updated_at=clock_timestamp()''',(who.id,group_id,instructions,current['revision']+1,active,interval))
                outcome=await group_on_connection(conn,who.id,group_id) if action=='group.rename' else await preferences_on_connection(conn,who.id,group_id)
            elif action=='profile.avatar':
                if set(raw)!={'revision','sha256'} or not isinstance(raw['sha256'],str) or not re.fullmatch(r'[a-f0-9]{64}',raw['sha256']):raise HTTPException(400,'形象文件无效')
                current=await profile_on_connection(conn,who.id);before=current
                if revision(raw['revision'])!=current['revision']:raise HTTPException(409,'形象已在另一端修改')
                from .resource_media import ResourceMedia
                image=await ResourceMedia(self.db.settings).read(conn,who.id,raw['sha256'])
                if not image or len(image)>2097152:raise HTTPException(413,'图片最大2MB')
                from .feed_media import avatar_mime
                avatar_mime(image)

                await conn.execute('INSERT INTO feed_agent_profiles(owner_id,name,image,revision) VALUES(%s,%s,%s,%s) ON CONFLICT(owner_id) DO UPDATE SET image=excluded.image,revision=excluded.revision,updated_at=clock_timestamp()',
                                   (who.id,current['name'],'/api/feed/avatar/'+raw['sha256'],current['revision']+1))
                outcome=await profile_on_connection(conn,who.id)
            elif action=='profile':
                if set(raw)-{'name','resetAvatar','revision'} or (('name' in raw)==('resetAvatar' in raw)):raise HTTPException(400,'请选择编辑名称或恢复默认形象')
                current=await profile_on_connection(conn,who.id);before=current
                if revision(raw.get('revision'))!=current['revision']:raise HTTPException(409,'名称或形象已在另一端修改')
                if 'resetAvatar' in raw and raw['resetAvatar'] is not True:raise HTTPException(400,'形象选项无效')
                name=text(raw['name'],40) if 'name' in raw else current['name'];image=None if 'resetAvatar' in raw else current['image']
                await conn.execute('''INSERT INTO feed_agent_profiles(owner_id,name,image,revision) VALUES(%s,%s,%s,%s)
                 ON CONFLICT(owner_id) DO UPDATE SET name=excluded.name,image=excluded.image,revision=excluded.revision,updated_at=clock_timestamp()''',(who.id,name,image,current['revision']+1))
                outcome=await profile_on_connection(conn,who.id)
            elif action=='post.mark':
                if not raw or set(raw)-{'liked','hidden','revision'} or not ({'liked','hidden'}&set(raw)) or any(type(raw[key]) is not bool for key in ('liked','hidden') if key in raw):raise HTTPException(400,'只允许修改喜欢和隐藏状态')
                current=await post_on_connection(conn,who.id,post_id);before=current
                if 'revision' in raw and revision(raw['revision'])!=current['revision']:raise HTTPException(409,'动态标记已变化')
                await conn.execute('''INSERT INTO feed_post_marks(owner_id,post_id,liked,hidden,revision) VALUES(%s,%s,%s,%s,%s)
                 ON CONFLICT(owner_id,post_id) DO UPDATE SET liked=excluded.liked,hidden=excluded.hidden,revision=excluded.revision,updated_at=clock_timestamp()''',(who.id,post_id,raw.get('liked',current['liked']),raw.get('hidden',current['hidden']),current['revision']+1))
                outcome=await post_on_connection(conn,who.id,post_id)
            elif action=='discussion':
                if set(raw)-{'text','modelTargetId'} or 'text' not in raw:raise HTTPException(400,'讨论内容无效')
                model_target=raw.get('modelTargetId')
                if model_target is not None and (not isinstance(model_target,str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,120}',model_target)):raise HTTPException(400,'帖子讨论模型标识无效')
                question=text(raw['text'],2000);await post_on_connection(conn,who.id,post_id)
                identifier='fm-'+uuid5(UUID(request_id),'feed-question').hex[:24]
                await conn.execute("INSERT INTO feed_messages(owner_id,id,post_id,request_id,role,text) VALUES(%s,%s,%s,%s,'user',%s)",(who.id,identifier,post_id,request_id,question))
                post_row=await(await conn.execute('SELECT group_id FROM feed_posts WHERE owner_id=%s AND id=%s',(who.id,post_id))).fetchone()
                discussion_group=await group_on_connection(conn,who.id,post_row['group_id'])
                outcome={'messageId':identifier,'postId':post_id,'groupId':post_row['group_id'],'revision':discussion_group['revision'],'messages':await discussion_on_connection(conn,who.id,post_id),'replyModelTargetId':model_target,'replyState':'awaiting_authorized_provider' if model_target else 'not_requested','assistantReplyGenerated':False}
            else:raise HTTPException(404,'动态操作不存在')
            result={'requestId':request_id,'state':'completed','result':outcome,'previous':before,'financialWrites':False}
            await conn.execute('INSERT INTO feed_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,request_id,hashed,Jsonb(result)))
            return result

    async def ingest_on_connection(self,conn,owner,group_id,posts,*,source_revision,source_page_id,expected_revision=None):
        if not isinstance(source_revision,str) or not source_revision or not isinstance(source_page_id,str) or not source_page_id:raise HTTPException(400,'文章原件与来源版本不可缺失')
        if not isinstance(posts,list) or len(posts)>100:raise HTTPException(400,'文章批次无效')
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+owner,))
        alive=await(await conn.execute('SELECT id FROM users WHERE id=%s AND deleted_at IS NULL AND active',(owner,))).fetchone()
        if not alive:raise HTTPException(409,'账号已停用，停止写入动态')
        group=await group_on_connection(conn,owner,group_id)
        if expected_revision is not None and revision(expected_revision)!=group['revision']:raise HTTPException(409,'组指示已变化，原任务不得写入新组')
        await conn.execute('INSERT INTO feed_groups(owner_id,id,name) VALUES(%s,%s,%s) ON CONFLICT(owner_id,id) DO NOTHING',(owner,group_id,group['name']))
        added=[]
        for raw in posts:
            payload=validate_post(raw)
            author=(payload.get('original') or {}).get('person',{}).get('id')
            if group['mode']=='people' and author not in group['people']:raise HTTPException(409,'人物原帖缺少已确认作者身份')
            fingerprint=hashlib.sha256(json.dumps({'kind':group['mode'],'author':author,'sources':sorted(source['url'] for source in payload['sources']),'platformPostId':(payload.get('original') or {}).get('platformPostId')},sort_keys=True,separators=(',',':')).encode()).hexdigest()
            identifier='fp-'+uuid5(UUID('921ae0c7-c574-40c1-b41b-a8e0f1cbb977'),owner+':'+group_id+':'+fingerprint).hex[:24]
            observed=datetime.now(UTC)
            if group['mode']=='people' and payload.get('publishedAt'):observed=datetime.fromisoformat(payload['publishedAt'])
            row=await(await conn.execute('''INSERT INTO feed_posts(owner_id,id,group_id,fingerprint,payload,kind,author_key,source_revision,source_page_id,sort_at)
             VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,group_id,fingerprint) DO NOTHING RETURNING id''',(owner,identifier,group_id,fingerprint,Jsonb(payload),group['mode'],author,source_revision,source_page_id,observed))).fetchone()
            if row:added.append(row['id'])
        return {'added':len(added),'postIds':added}

    async def append_reply_on_connection(self,conn,owner,post_id,request_id,text_value,source_revision,source_page_id):
        if not source_revision or not source_page_id:raise HTTPException(400,'讨论回复须保留真实来源原件')
        request_id=str(UUID(request_id));answer=text(text_value,20000)
        question=await(await conn.execute("SELECT id FROM feed_messages WHERE owner_id=%s AND post_id=%s AND request_id=%s AND role='user'",(owner,post_id,request_id))).fetchone()
        if not question:raise HTTPException(409,'原讨论请求不存在')
        identifier='fm-'+uuid5(UUID(request_id),'feed-answer').hex[:24]
        prior=await(await conn.execute("SELECT text,source_revision,source_page_id FROM feed_messages WHERE owner_id=%s AND request_id=%s AND role='assistant'",(owner,request_id))).fetchone()
        if prior:
            if prior['text']!=answer or prior['source_revision']!=source_revision or prior['source_page_id']!=source_page_id:raise HTTPException(409,'原讨论回复不可覆盖')
        else:await conn.execute("INSERT INTO feed_messages(owner_id,id,post_id,request_id,role,text,source_revision,source_page_id) VALUES(%s,%s,%s,%s,'assistant',%s,%s,%s)",(owner,identifier,post_id,request_id,answer,source_revision,source_page_id))
        return {'messages':await discussion_on_connection(conn,owner,post_id),'replyState':'observed'}


def validate_mode(mode,people):
    if mode not in ('news','people') or not isinstance(people,list) or not 1<=len(people)<=len(PEOPLE) or any(not isinstance(person,str) or person not in PEOPLE for person in people) or len(set(people))!=len(people):raise HTTPException(400,'请选择有效且不重复的人物与动态类型')


def validate_post(raw):
    if not isinstance(raw,dict):raise HTTPException(400,'文章内容无效')
    if raw.get('original') is not None and not isinstance(raw['original'],dict):raise HTTPException(400,'文章原件身份无效')
    value=dict(raw);value['title']=text(raw.get('title'),300);value['icon']=raw.get('icon') or 'note'
    if value['icon'] not in ICONS:raise HTTPException(400,'文章图标无效')
    if not isinstance(value.get('segments'),list) or not value['segments'] or len(value['segments'])>100:raise HTTPException(400,'文章正文缺失')
    for segment in value['segments']:
        if not isinstance(segment,dict):raise HTTPException(400,'文章片段无效')
        text(segment.get('text'),20000)
    if not isinstance(value.get('sources'),list) or not 1<=len(value['sources'])<=30:raise HTTPException(400,'文章须保留真实来源')
    ids=set()
    for source in value['sources']:
        if not isinstance(source,dict) or not isinstance(source.get('id'),str) or not source['id'] or source['id'] in ids:raise HTTPException(400,'文章来源标识无效')
        ids.add(source['id']);source_url(source.get('url'));text(source.get('title'),500)
    for segment in value['segments']:
        if segment.get('sourceId') is not None and segment['sourceId'] not in ids:raise HTTPException(400,'文章片段引用来源缺失')
    for media in value.get('media',[]):
        if not isinstance(media,dict) or media.get('type') not in ('image','video'):raise HTTPException(400,'文章媒体无效')
        source_url(media.get('url'))
        if media.get('poster'):source_url(media['poster'])
    published=value.get('publishedAt')
    if published is not None:
        try:
            observed=datetime.fromisoformat(published)
            if observed.tzinfo is None or (observed-datetime.now(UTC)).total_seconds()>60:raise ValueError()
        except (ValueError,TypeError,AttributeError):raise HTTPException(400,'文章发表时间无效') from None
    value.setdefault('media',[]);value.setdefault('publishedAt',None)
    if len(json.dumps(value,ensure_ascii=False,allow_nan=False).encode())>1024*1024:raise HTTPException(413,'文章内容过长')
    return value
