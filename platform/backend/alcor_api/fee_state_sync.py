"""Fee field sync is a transactional adapter over FeePlans, never another rule store."""

from uuid import UUID, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fee_plan_sources import original
from .fee_plans import FeePlans, fee_limit, validate_rule
from .market_worker import Bound
from .watch_state import authorized
from .watch_state_contract import canonical, mutation, request_id


async def overlay_fields(conn,owner,fields,provenance,rows):
    installed=await(await conn.execute("SELECT to_regclass('public.fee_state_fields') AS present")).fetchone()
    if not installed['present']:
        marker=await(await conn.execute("SELECT 1 FROM schema_migrations WHERE name='0120_fee_state_sync.sql'")).fetchone()
        if marker:raise HTTPException(503,'费率同步结构不可用')
        return
    metadata=await(await conn.execute('SELECT * FROM fee_state_fields WHERE owner_id=%s ORDER BY field LIMIT 10001',(owner,))).fetchall()
    if len(metadata)>10000:raise HTTPException(409,'费率同步字段超出读取范围')
    heads={str(row['id']):row['current_revision'] for row in rows}
    active={str(row['id']) for row in rows if row['retired_at'] is None}
    for meta in metadata:
        key=meta['field'];current=heads.get(str(meta['plan_id']),0)
        advanced=key.startswith('plan/') and str(meta['plan_id']) in active and current>meta['domain_revision']
        if meta['tombstone'] and not advanced:
            fields[key]={'revision':meta['revision'],'value':None}
            provenance[key]={'authority':'retained_deletion_tombstone','originalBytesRetained':False,'historicalRulesDeleted':False}
        elif key.startswith('history/') and key not in fields:
            from .fee_plan_sources import platform_projection
            parts=key.split('/')
            matching=[row for row in rows if str(row['id'])==str(meta['plan_id']) and str(row['revision'])==parts[-1]]
            if len(matching)!=1:raise HTTPException(409,'历史费率原件缺失')
            stored=matching[0]
            value=stored['legacy_original_base64']
            if value is None:value=platform_projection(stored,validate_rule,legacy_id=parts[1])
            if original(value)['id']!=parts[1]:raise HTTPException(409,'费率原始字段身份不一致')
            fields[key]={'revision':meta['revision'],'value':value}
            provenance[key]={'authority':'retained_legacy_original' if stored['legacy_original_base64'] is not None else 'platform_revision_projection_not_original','originalBytesRetained':stored['legacy_original_base64'] is not None,'market':stored['market']}
        elif key in fields:
            fields[key]['revision']=meta['revision']+max(0,current-meta['domain_revision']) if key.startswith('plan/') else meta['revision']
        else:
            raise HTTPException(409,'费率同步字段所指原件缺失，不能假空值')


def decoded(key,value):
    parts=key.split('/')
    if len(parts) not in (2,3) or parts[0] not in ('plan','history') or (parts[0]=='plan')!=(len(parts)==2):
        raise HTTPException(400,'费率标识无效')
    try:
        identifier=str(UUID(parts[1]))
        if len(parts)==3 and (not parts[2].isascii() or not parts[2].isdecimal() or str(int(parts[2]))!=parts[2] or int(parts[2])<1):raise ValueError()
        if value is None:return identifier,None
        source=original(value)
        if source['id']!=parts[1] or type(source['revision']) is not int or source['revision']<1 or (len(parts)==3 and source['revision']!=int(parts[2])):raise ValueError()
        # Full source contract validation is shared with the canonical domain below.
        from .fee_plan_sources import normalize
        command={'requestId':str(UUID(int=0)),'planId':identifier,'revision':source['revision']-1,
                 'accountId':source['accountID'],'providerId':source['providerID'],'market':source['market'],
                 'effectiveFrom':source['effectiveFrom'],'effectiveThrough':source.get('effectiveThrough'),
                 'components':source['overrides'],'legacyOriginal':value,'confirmed':True}
        normalize(command,validate_rule)
        return identifier,command
    except (ValueError,TypeError,KeyError,ArithmeticError,UnicodeError):
        raise HTTPException(400,'费率原始内容或版本无效') from None


class FeeStateSync:
    def __init__(self,db):self.db=db

    async def receipt(self,who,identifier):
        identifier=request_id(identifier)
        async with self.db.connection() as conn,conn.transaction():
            await authorized(conn,who)
            row=await(await conn.execute('SELECT result FROM fee_state_operations WHERE owner_id=%s AND request_id=%s',(who.id,identifier))).fetchone()
            if not row:raise HTTPException(404,'同步回执尚未找到')
            return row['result']

    async def submit(self,who,raw):
        data,hashed=mutation(raw)
        if data['namespace']!='fees':raise HTTPException(400,'同步类别无效')
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
            await authorized(conn,who,True)
            # The shared cash lock also serializes normal FeePlans writers.
            plans=FeePlans(Bound(conn,self.db.settings),_batch_budget=True)
            await plans.cash.lock(conn,who)
            if await(await conn.execute('SELECT 1 FROM watch_display_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone():
                raise HTTPException(409,'请求标识已用于其他同步类别')
            prior=await(await conn.execute('SELECT fingerprint,result FROM fee_state_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone()
            if prior:
                if prior['fingerprint']!=hashed:raise HTTPException(409,'请求标识已使用')
                return prior['result']
            parsed={item['key']:decoded(item['key'],item['value']) for item in data['changes']}
            await fee_limit(Bound(conn,self.db.settings),who)
            old=await plans.legacy_fields_on_connection(conn,who)
            fields=old['fields'];changes={item['key']:item for item in data['changes']}
            conflict=any(fields.get(item['key'],{'revision':0})['revision']!=item['revision'] for item in data['changes'])
            if not conflict:
                merged={key:item['value'] for key,item in fields.items()}
                merged.update({key:item['value'] for key,item in changes.items()})
                if len(merged)>10000 or len(canonical(merged).encode())>4*1024*1024:raise HTTPException(400,'共享内容超过当前容量')
                # An existing history field is immutable, including deletion attempts.
                for key,item in changes.items():
                    previous=fields.get(key,{}).get('value')
                    if key.startswith('history/') and previous is not None and previous!=item['value']:
                        raise HTTPException(409,'历史费率证据不可覆盖')
                    if key.startswith('plan/') and previous is not None and previous!=item['value']:
                        source=original(previous);history='history/'+source['id']+'/'+str(source['revision'])
                        if merged.get(history)!=previous:raise HTTPException(409,'请保留本次替换的原费率证据')
                        if item['value'] is not None:
                            following=original(item['value'])
                            if following['revision']!=source['revision']+1 or any(following[name]!=source[name] for name in ('accountID','providerID','market')):
                                raise HTTPException(409,'费率身份或原版本已变化')
                commands={}
                for key,(pid,command) in parsed.items():
                    if command is None or fields.get(key,{}).get('value')==changes[key]['value']:continue
                    revision=command['revision']+1
                    pair=(pid,revision)
                    if pair in commands and commands[pair]['legacyOriginal']!=command['legacyOriginal']:raise HTTPException(409,'相同费率版本有不同原件')
                    commands[pair]=command
                for (pid,revision),command in sorted(commands.items()):
                    saved=await(await conn.execute('SELECT legacy_original_base64 FROM fee_plan_revisions WHERE owner_id=%s AND id=%s AND revision=%s',(who.id,pid,revision))).fetchone()
                    if saved:
                        same_projection=any(entry['value']==command['legacyOriginal'] for entry in fields.values())
                        if saved['legacy_original_base64']!=command['legacyOriginal'] and not (saved['legacy_original_base64'] is None and same_projection):raise HTTPException(409,'已保存费率版本原件不能替换')
                        continue
                    active_head=await(await conn.execute('SELECT revision,retired_at FROM fee_plan_heads WHERE owner_id=%s AND id=%s',(who.id,pid))).fetchone()
                    if active_head and active_head['retired_at'] is None and not any(key.startswith('plan/') and parsed[key][0]==pid for key in changes):
                        raise HTTPException(409,'新增历史不能替换当前生效费率，请一并明确当前计划')
                    command['requestId']=str(uuid5(UUID(data['requestId']),'fee-state:'+pid+':'+str(revision)))
                    preview=await plans.preview(who,command)
                    await plans.submit(who,command,preview['preview'])
                    if not any(key.startswith('plan/') and parsed[key][0]==pid for key in changes) and not any(key.startswith('plan/') and str(UUID(key.split('/')[1]))==pid and entry['value'] is not None for key,entry in fields.items()):
                        await conn.execute('UPDATE fee_plan_heads SET retired_at=clock_timestamp() WHERE owner_id=%s AND id=%s',(who.id,pid))
                for key,item in changes.items():
                    pid,_=parsed[key]
                    head=await(await conn.execute('SELECT revision,retired_at FROM fee_plan_heads WHERE owner_id=%s AND id=%s',(who.id,pid))).fetchone()
                    if key.startswith('plan/'):
                        if item['value'] is None:
                            await conn.execute('UPDATE fee_plan_previews SET consumed_at=clock_timestamp() WHERE owner_id=%s AND consumed_at IS NULL',(who.id,))
                            await conn.execute('UPDATE fee_plan_heads SET retired_at=COALESCE(retired_at,clock_timestamp()) WHERE owner_id=%s AND id=%s',(who.id,pid))
                        else:
                            command=parsed[key][1]
                            if head and head['retired_at'] is not None:raise HTTPException(409,'已停用费率须通过显式新修订恢复')
                            if not head or head['revision']!=command['revision']+1:raise HTTPException(409,'当前费率必须指向真实最新版本')
                            await conn.execute('UPDATE fee_plan_heads SET retired_at=NULL WHERE owner_id=%s AND id=%s',(who.id,pid))
                    await conn.execute('INSERT INTO fee_state_fields(owner_id,field,revision,plan_id,domain_revision,tombstone) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,field) DO UPDATE SET revision=excluded.revision,plan_id=excluded.plan_id,domain_revision=excluded.domain_revision,tombstone=excluded.tombstone',
                                       (who.id,key,item['revision']+1,pid,head['revision'] if head else 0,item['value'] is None))
                # History-only imports have no active-plan declaration; retain the original without activation.
                for pid in {pair[0] for pair in commands}:
                    if not any(key.startswith('plan/') and parsed[key][0]==pid for key in changes) and not any(key.startswith('plan/') and str(UUID(key.split('/')[1]))==pid and entry['value'] is not None for key,entry in fields.items()):
                        await conn.execute('UPDATE fee_plan_heads SET retired_at=COALESCE(retired_at,clock_timestamp()) WHERE owner_id=%s AND id=%s',(who.id,pid))
            current=await plans.legacy_fields_on_connection(conn,who)
            result={'requestId':data['requestId'],'userId':who.id,'namespace':'fees','state':'conflict' if conflict else 'completed','code':40902 if conflict else 0,
                    'message':'其他设备已修改相同内容，请核对后再保存' if conflict else 'ok',
                    'data':{**current,'partial':True,'fields':{key:value for key,value in current['fields'].items() if key in changes}}}
            await conn.execute('INSERT INTO fee_state_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],hashed,Jsonb(result)))
            return result
