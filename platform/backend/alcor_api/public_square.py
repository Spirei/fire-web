"""Public projection of explicitly licensed original-person observations only."""

import base64
import hashlib
import json
import re
from datetime import datetime
from urllib.parse import urlsplit

from fastapi import HTTPException

from .feed_core import stamp
from .feed_sources import FeedSources, fingerprint

PEOPLE={'trump','duan'}
DUAN_USER={'id':'1247347556','handle':'slowisquick','name':'大道无形我有型'}
SOURCE='https://trumpstruth.org/'


def cursor_value(value):
    if not value:return None
    try:
        if not isinstance(value,str) or len(value)>256:raise ValueError()
        result=json.loads(base64.urlsafe_b64decode(value+'='*(-len(value)%4)))
        if not isinstance(result,list) or len(result)!=2 or not isinstance(result[0],str) or not isinstance(result[1],str) or not re.fullmatch(r'[a-f0-9]{64}',result[1]):raise ValueError()
        moment=datetime.fromisoformat(result[0])
        if moment.tzinfo is None:raise ValueError()
        return moment,result[1]
    except (ValueError,TypeError,UnicodeError):raise HTTPException(400,'人物动态分页游标无效') from None


def public_post(row,person,target):
    original=row['original']
    if not isinstance(original,dict) or not isinstance(original.get('person'),dict) or original['person'].get('id')!=person or original.get('sourceTargetId')!=target['id']:return None
    identifier=original.get('platformPostId');body=original.get('text');url=original.get('originalUrl')
    if not isinstance(identifier,str) or not identifier or len(identifier)>250 or not isinstance(body,str) or not isinstance(url,str):return None
    # Only source-confirmed original URL/text/date; no model summary or inferred author.
    from .feed_parse import public_url
    if not public_url(url):return None
    parsed_url=urlsplit(url)
    if person=='duan':
        if parsed_url.hostname!='xueqiu.com' or parsed_url.path.rstrip('/')!='/1247347556/'+identifier:return None
    else:
        fields=original.get('sourceFields',{})
        archive=urlsplit(fields.get('archiveUrl','')) if isinstance(fields,dict) else urlsplit('')
        archive_matches=archive.scheme=='https' and archive.hostname=='trumpstruth.org' and archive.path.rstrip('/')=='/statuses/'+identifier
        truth_matches=re.fullmatch(r'/@realDonaldTrump/[0-9]+',parsed_url.path.rstrip('/'))
        if parsed_url.hostname!='truthsocial.com' or not (truth_matches or archive_matches and parsed_url.path.rstrip('/')=='/@realDonaldTrump'):return None
        if not archive_matches and parsed_url.path.rstrip('/').rsplit('/',1)[-1]!=identifier:return None
    published=row['published_at']
    if not isinstance(published,str):return None
    try:
        moment=datetime.fromisoformat(published)
        if moment.tzinfo is None:return None
    except (ValueError,TypeError):return None
    result={'id':identifier,'date':published,'text':body,'originalUrl':url,'author':person,
            'sourceEvidence':{'sourceRevision':row['source_revision'],'pageId':str(row['page_id']),'licenseRevision':row['license_revision'],'authority':'verified_person_original','receivedAt':stamp(row['received_at'])}}
    # Provider translations/replies are kept only when the people parser recorded them.
    if target.get('translationPublicDisplay') is True and isinstance(original.get('textZh'),str):
        result['textZh']=original['textZh']
        result['translationAuthority']='installed_source_translation'
    fields=original.get('sourceFields',{})
    if not isinstance(fields,dict):fields={}
    if isinstance(fields.get('replyTo'),str):result['replyTo']=fields['replyTo'][:250]
    if isinstance(fields.get('categories'),list):result['categories']=[item for item in fields['categories'] if isinstance(item,str) and len(item)<=100][:30]
    if public_url(fields.get('archiveUrl')):result['archiveUrl']=fields['archiveUrl']
    quote=fields.get('quote')
    if isinstance(quote,dict):
        result['quote']={key:quote[key] for key in ('name','text') if isinstance(quote.get(key),str)}
        if public_url(quote.get('url')):result['quote']['url']=quote['url']
        if isinstance(quote.get('images'),list):result['quote']['images']=[u for u in quote['images'] if public_url(u)]
    if isinstance(fields.get('images'),list):result['images']=[u for u in fields['images'] if public_url(u)]
    media=original.get('media') or row.get('media')
    if isinstance(media,list):
        result['media']=[{'type':item['type'],'url':item['url'],'alt':item.get('alt','')} for item in media if isinstance(item,dict) and item.get('type') in ('image','video') and public_url(item.get('url'))]
    comments=fields.get('comments')
    if isinstance(comments,list):
        result['comments']=[]
        for comment in comments[:100]:
            if not isinstance(comment,dict) or not isinstance(comment.get('id'),str) or not isinstance(comment.get('text'),str):continue
            item={key:comment[key] for key in ('id','name','text','createdAt','replyTo') if isinstance(comment.get(key),str)}
            if public_url(comment.get('avatar')):item['avatar']=comment['avatar']
            likes=comment.get('likes')
            if type(likes) is int and likes>=0:item['likes']=likes
            result['comments'].append(item)
    # No feed-private discussions, likes, hidden marks, profile or owner IDs are public.
    return result


class PublicSquare:
    def __init__(self,db):self.db=db;self.sources=FeedSources(db)

    async def read(self,*,author=None,cursor=None,limit=30,legacy=False):
        if author is not None and author not in PEOPLE:raise HTTPException(400,'人物筛选无效')
        if type(limit) is not int or not 1<=limit<=(5000 if legacy else 200):raise HTTPException(400,'分页条数无效')
        boundary=cursor_value(cursor)
        requested={author} if author else PEOPLE
        candidates={person:[] for person in requested}
        for configured in self.db.settings.feed_targets:
            person=configured.get('personId')
            if person not in requested or configured.get('publicDisplay') is not True:continue
            try:target=self.sources.target(configured.get('ownerId'),configured.get('id'))
            except HTTPException:continue
            if target.get('provider') not in ('person-original-json','trump-archive-html','xueqiu-status-json') or target.get('purpose')!='feed.person.read':continue
            candidates[person].append(target)
        missing=[];targets={}
        for person,values in candidates.items():
            if len(values)!=1:missing.append({'personId':person,'reason':'public_source_unavailable' if not values else 'ambiguous_public_sources'})
            else:targets[person]=values[0]
        posts=[];observed={};refresh_minutes={};truncated=False;translation_missing=[]
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            for person,target in targets.items():
                owner=target['ownerId'];target_hash=fingerprint(target)
                active=await(await conn.execute('SELECT id FROM users WHERE id=%s AND active AND deleted_at IS NULL FOR SHARE',(owner,))).fetchone()
                if not active:missing.append({'personId':person,'reason':'source_owner_unavailable'});continue
                rows=await(await conn.execute('''SELECT p.id,p.payload->'original' AS original,p.payload->>'publishedAt' AS published_at,p.payload->'media' AS media,
                    p.source_revision,s.id AS page_id,s.license_revision,s.received_at,p.created_at
                    FROM feed_posts p JOIN feed_source_pages s ON s.owner_id=p.owner_id AND s.id::text=p.source_page_id
                    JOIN feed_source_admissions a ON a.owner_id=s.owner_id AND a.job_id=s.job_id AND a.target_key=s.target_key
                    WHERE p.owner_id=%s AND p.kind='people' AND p.author_key=%s AND p.source_revision=%s
                    AND s.target_id=%s AND s.target_fingerprint=%s AND s.license_revision=%s AND s.complete
                    AND a.target_fingerprint=s.target_fingerprint AND a.target_id=s.target_id AND a.license_revision=s.license_revision AND a.purpose='feed.person.read'
                    AND (%s::timestamptz IS NULL OR (p.sort_at,encode(sha256(convert_to(p.author_key||':'||(p.payload->'original'->>'platformPostId'),'UTF8')),'hex'))<(%s::timestamptz,%s::text))
                    ORDER BY p.sort_at DESC,encode(sha256(convert_to(p.author_key||':'||(p.payload->'original'->>'platformPostId'),'UTF8')),'hex') DESC LIMIT 5001''',(owner,person,target_hash,target['id'],target_hash,target['licenseRevision'],boundary[0] if boundary else None,boundary[0] if boundary else None,boundary[1] if boundary else None))).fetchall()
                if not rows and boundary is None:missing.append({'personId':person,'reason':'no_verified_original_observations'})
                if len(rows)>5000:truncated=True
                if len(rows)>5000 and legacy:raise HTTPException(409,'人物历史超出旧接口完整响应预算，请使用分页读取')
                seen={};verified_pages={}
                for row in rows[:5000]:
                    page_key=str(row['page_id'])
                    if page_key not in verified_pages:
                        if len(verified_pages)>=64:
                            missing.append({'personId':person,'reason':'original_verification_page_budget'});continue
                        page=await(await conn.execute('SELECT raw,raw_sha256,http_status,representation FROM feed_source_pages WHERE owner_id=%s AND id=%s',(owner,row['page_id']))).fetchone()
                        parsed=[]
                        if page and page['http_status']==200 and page['representation']==target['provider']+'_http_response_body' and hashlib.sha256(bytes(page['raw'])).hexdigest()==page['raw_sha256']:
                            from .feed_people import parse_people
                            try:parsed=parse_people(bytes(page['raw']),target)['posts']
                            except (ValueError,TypeError,KeyError,UnicodeError,HTTPException):pass
                        indexed={}
                        for post in parsed:
                            indexed.setdefault((post.get('original') or {}).get('platformPostId'),[]).append(post)
                        verified_pages[page_key]=indexed
                    matches=[post for post in verified_pages[page_key].get((row['original'] or {}).get('platformPostId'),[]) if post.get('original')==row['original'] and post.get('publishedAt')==row['published_at']]
                    if len(matches)!=1:
                        missing.append({'personId':person,'reason':'original_page_projection_unverified'});continue
                    value=public_post(row,person,target)
                    if value is None:
                        missing.append({'personId':person,'reason':'unverified_original_identity_or_date'});continue
                    identifier=value['id']
                    if identifier in seen:
                        if seen[identifier]['text']!=value['text']:raise HTTPException(409,'相同原帖存在不同已保存原文，请先核对来源')
                        continue
                    value['_cursor']=hashlib.sha256((person+':'+identifier).encode()).hexdigest()
                    seen[identifier]=value
                    observed[person]=max(observed.get(person,row['received_at']),row['received_at'])
                if target.get('translationPublicDisplay') is True and seen:
                    from .feed_model import FeedModel
                    translations=await(await conn.execute('''SELECT r.result,s.id,s.job_id,s.raw,s.raw_sha256,s.target_id,s.target_fingerprint,s.license_revision,s.received_at
                     FROM feed_source_results r JOIN feed_source_pages s ON s.owner_id=r.owner_id AND s.id=r.page_id AND s.job_id=r.job_id AND s.target_key=r.target_key
                     JOIN feed_source_admissions a ON a.owner_id=s.owner_id AND a.job_id=s.job_id AND a.target_key=s.target_key
                     WHERE r.owner_id=%s AND r.result->>'purpose'='feed.translate' AND r.result->>'state'='succeeded'
                     AND s.complete AND s.http_status=200 AND s.representation='model_http_response_body' AND a.purpose='feed.translate' AND a.target_fingerprint=s.target_fingerprint AND a.target_id=s.target_id AND a.license_revision=s.license_revision
                     ORDER BY s.received_at DESC,s.id DESC LIMIT 1001''',(owner,))).fetchall()
                    if len(translations)>1000:missing.append({'personId':person,'reason':'translation_history_budget'})
                    translated=set()
                    for saved in translations[:1000]:
                        try:model=FeedModel(self.db).target(owner,saved['target_id'],purpose='feed.translate')
                        except HTTPException:continue
                        if model.get('publicDisplay') is not True or fingerprint(model)!=saved['target_fingerprint'] or model['licenseRevision']!=saved['license_revision']:continue
                        for translation in saved['result'].get('translations',[]):
                            if not isinstance(translation,dict):continue
                            pid=translation.get('platformPostId');post=seen.get(pid)
                            if not post or pid in translated or translation.get('personId')!=person or translation.get('text')!=post['text'] or translation.get('sourcePageId')!=post['sourceEvidence']['pageId'] or not isinstance(translation.get('textZh'),str):continue
                            from .public_square_evidence import verified_translation
                            if not await verified_translation(conn,saved,model,translation,post,owner):
                                translation_missing.append({'personId':person,'reason':'translation_original_unverified'});continue
                            try:current_model=FeedModel(self.db).target(owner,saved['target_id'],purpose='feed.translate')
                            except HTTPException:continue
                            if current_model.get('publicDisplay') is not True or fingerprint(current_model)!=saved['target_fingerprint']:continue
                            post['textZh']=translation['textZh'];post['translationAuthority']='licensed_model_translation'
                            post['translationEvidence']={'pageId':str(saved['id']),'licenseRevision':saved['license_revision'],'receivedAt':stamp(saved['received_at'])}
                            translated.add(pid)
                current=self.sources.target(owner,target['id'])
                if current.get('publicDisplay') is not True or fingerprint(current)!=target_hash:raise HTTPException(503,'人物公共展示许可已变化')
                posts.extend(seen.values())
                interval=target.get('refreshMinutes')
                if type(interval) is int and interval>0:refresh_minutes[person]=interval
        posts.sort(key=lambda row:(datetime.fromisoformat(row['date']),row['_cursor']),reverse=True)
        if boundary:posts=[post for post in posts if (datetime.fromisoformat(post['date']),post['_cursor'])<boundary]
        selected=posts[:limit]
        last=selected[-1] if selected else None
        next_cursor=base64.urlsafe_b64encode(json.dumps([last['date'],last['_cursor']],separators=(',',':')).encode()).decode().rstrip('=') if last and len(posts)>limit else None
        for post in selected:post.pop('_cursor',None)
        output={'state':'unavailable' if not targets or not selected and missing else 'partial' if missing or truncated else 'observed',
                'posts':selected,'nextCursor':next_cursor,'updatedAt':stamp(max(observed.values())) if observed else None,
                'updatedByAuthor':{person:stamp(observed.get(person)) for person in sorted(PEOPLE)},'missing':missing,
                'coverage':{'completeHistory':False,'retainedProjectionComplete':not truncated and not missing,'basis':'retained_licensed_observations_not_full_person_history','boundedRowsPerSource':5000,'collectionOnRead':False},
                'translationMissing':translation_missing,'source':'stored-licensed-person-originals','refreshing':False,'refreshingByAuthor':{'trump':False,'duan':False},
                'refreshMinutes':{person:refresh_minutes.get(person) for person in PEOPLE},'collectionOnRead':False}
        if len(json.dumps(output,ensure_ascii=False).encode())>2*1024*1024:raise HTTPException(409,'人物内容超出响应预算，请缩小分页条数')
        return output
