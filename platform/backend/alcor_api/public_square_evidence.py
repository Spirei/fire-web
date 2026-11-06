"""Verify public translations against retained model bytes and the same original job."""
import hashlib
import json


def translated_text(raw,provider,translation):
    from .fx_provider_parser import unique
    if provider=='mymemory':
        value=json.loads(raw,object_pairs_hook=unique)
        text=value['responseData']['translatedText']
        if value.get('responseStatus')!=200 or not isinstance(text,str):return None
        return text.strip()
    value=json.loads(raw,object_pairs_hook=unique)
    choice=value['choices'][0]
    if choice.get('finish_reason')!='stop':return None
    content=json.loads(choice['message']['content'],object_pairs_hook=unique)
    if not isinstance(content,list) or len(content)>20:return None
    rows=[row for row in content if isinstance(row,dict) and row.get('personId')==translation.get('personId') and row.get('platformPostId')==translation.get('platformPostId')]
    return rows[0].get('textZh') if len(rows)==1 else None


async def verified_translation(conn,saved,model,translation,post,owner):
    try:
        raw=bytes(saved['raw'])
        if hashlib.sha256(raw).hexdigest()!=saved['raw_sha256']:return False
        source=await(await conn.execute('SELECT job_id,raw,raw_sha256,complete,http_status FROM feed_source_pages WHERE owner_id=%s AND id=%s',(owner,translation['sourcePageId']))).fetchone()
        if (not source or source['job_id']!=saved['job_id'] or not source['complete'] or source['http_status']!=200
                or hashlib.sha256(bytes(source['raw'])).hexdigest()!=source['raw_sha256']):return False
        if translation.get('text')!=post['text'] or translation.get('sourcePageId')!=post['sourceEvidence']['pageId']:return False
        text=translated_text(raw,model['provider'],translation)
        return isinstance(text,str) and 0<len(text)<=20000 and text==translation.get('textZh')
    except (ValueError,TypeError,KeyError,IndexError):return False
