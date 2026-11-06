"""Encrypted PG runtime overlays. Database identity and installation paths never change."""

import copy
import hashlib
import ipaddress
import json
import re
from datetime import UTC, datetime
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from psycopg.types.json import Jsonb
from pydantic import SecretStr

from .connections import Vault
from .notification_security import NotificationSecurity
from .security import lock_mutation_identity

SOURCE_FIELDS=('public_market_data_policies','public_market_source_targets','public_discovery_policies','public_discovery_targets','public_earnings_targets','public_reference_policies','public_sec_targets','market_data_policies','dividend_source_targets','fx_provider_targets','market_discovery_targets','earnings_targets','sec_company_targets','sec_financial_targets','broker_statement_targets','record_ocr_targets','card_ocr_targets','feed_targets','feed_model_targets','celeb_source_targets','asset_source_targets','public_ticker')
SMTP_FIELDS=('smtpEnabled','smtpHost','smtpPort','smtpSecure','smtpFromName','smtpFromEmail','emailLinkOrigin','smtpApproval','mailTimeout','smtpUser','smtpPassword')
MODEL_FIELDS=('modelServices','activeModelServiceId')
GROUP_FIELDS={'smtp':SMTP_FIELDS,'models':MODEL_FIELDS,'sources':SOURCE_FIELDS+('quoteSource','peopleRefreshIntervals','translationEnabled','translationProvider','translationApiUrl','translationApproval'),
              'notifications':('business_notification_targets','legacyChannelSettings'),'scheduling':('worker_poll_seconds','lease_seconds'),
              'cookies':('xueqiuCookieTargetId','xueqiuCookie','_xueqiuCredentialCiphertext')}
SECRET_WORDS=re.compile(r'password|secret|token|credential|cookie|api_?key|aeskey|encryptkey|webhook',re.IGNORECASE)
SMTP_MAP={'smtpEnabled':'mail_enabled','smtpHost':'mail_host','smtpPort':'mail_port','smtpSecure':'mail_tls','smtpUser':'mail_username','smtpPassword':'mail_password','smtpFromEmail':'mail_sender','smtpFromName':'mail_from_name','emailLinkOrigin':'email_link_origin','mailTimeout':'mail_timeout','smtpApproval':'mail_delivery_policy'}


def primitive(value):
    if isinstance(value,SecretStr):return value.get_secret_value()
    if isinstance(value,dict):return {key:primitive(item) for key,item in value.items()}
    if isinstance(value,(list,tuple)):return [primitive(item) for item in value]
    if isinstance(value,UUID):return str(value)
    return value


def canonical(value):return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False)


def base_snapshot(settings):
    stored=getattr(settings,'_private_runtime_installation_base',None)
    if stored is not None:return copy.deepcopy(stored)
    smtp={key:primitive(getattr(settings,attribute,None)) for key,attribute in SMTP_MAP.items()}
    smtp['smtpSecure']=getattr(settings,'mail_tls','starttls')=='tls'
    smtp['smtpFromName']=smtp.get('smtpFromName') or '';smtp['emailLinkOrigin']=smtp.get('emailLinkOrigin') or '';smtp['smtpApproval']=smtp.get('smtpApproval') or {}
    models={'modelServices':primitive(getattr(settings,'provider_model_targets',[])),'activeModelServiceId':getattr(settings,'active_model_service_id','')}
    result={'smtp':smtp,'models':models,'sources':{key:primitive(getattr(settings,key,{} if key=='public_ticker' else [])) for key in SOURCE_FIELDS},
            'notifications':{'business_notification_targets':primitive(settings.business_notification_targets),'legacyChannelSettings':{}},'scheduling':{'worker_poll_seconds':settings.worker_poll_seconds,'lease_seconds':settings.lease_seconds},
            'cookies':{'xueqiuCookieTargetId':'','xueqiuCookie':''}}
    object.__setattr__(settings,'_private_runtime_installation_base',copy.deepcopy(result))
    return result


def is_secret(key):return (key=='smtpUser' or bool(SECRET_WORDS.search(key))) and key not in ('xueqiuCookieTargetId',)

def sensitive_url(value):
    if not isinstance(value,str) or '://' not in value:return False
    from urllib.parse import parse_qs
    parsed=urlsplit(value)
    return bool(parsed.username or parsed.password or any(SECRET_WORDS.search(key) for key in parse_qs(parsed.query)))


def redact(value,path='',states=None):
    states={} if states is None else states
    if isinstance(value,dict):
        result={}
        for key,item in value.items():
            location=path+'.'+key if path else key
            if key.startswith('_'):continue
            if is_secret(key) or sensitive_url(item):states[location]='configured' if item else 'unset';continue
            result[key]=redact(item,location,states)
        return result
    if isinstance(value,list):return [redact(item,path+'.'+str(item.get('id',index)) if isinstance(item,dict) else path+'.'+str(index),states) for index,item in enumerate(value)]
    return value


def merge_nonsecret(old,patch):
    if isinstance(patch,dict):
        result=copy.deepcopy(old) if isinstance(old,dict) else {}
        for key,value in patch.items():
            if is_secret(key) or sensitive_url(value):raise HTTPException(422,'秘密须使用明确的保留、设置或清除动作')
            result[key]=merge_nonsecret(result.get(key),value)
        return result
    if isinstance(patch,list):
        old_by_id={row.get('id'):row for row in old or [] if isinstance(row,dict)} if isinstance(old,list) else {}
        return [merge_nonsecret(old_by_id.get(row.get('id'),{}),row) if isinstance(row,dict) else row for row in patch]
    return copy.deepcopy(patch)


def locate(value,path):
    parts=path.split('.');current=value
    for part in parts[:-1]:
        if isinstance(current,list):
            matches=[row for row in current if isinstance(row,dict) and row.get('id')==part]
            if len(matches)!=1:raise HTTPException(422,'秘密所属目标不存在或有歧义')
            current=matches[0]
        elif isinstance(current,dict) and part in current:current=current[part]
        else:raise HTTPException(422,'秘密字段路径无效')
    if not isinstance(current,dict) or not (is_secret(parts[-1]) or parts[-1].lower().endswith('url')) or parts[-1].startswith('_'):raise HTTPException(422,'秘密字段路径无效')
    return current,parts[-1]


def approval(raw,who,settings,*,host=None,purpose=None):
    if not isinstance(raw,dict) or set(raw)-{'id','host','port','path','addresses','approvedAccess','licenseRevision','expiresAt','ownerId','instanceId','purpose','purposes','mode','allowPrivate','allowPlaintext','publicDisplay'}:raise HTTPException(422,'需要明确许可与固定目标')
    try:
        if raw['approvedAccess'] is not True or raw['ownerId']!=who.id or str(raw['instanceId'])!=str(settings.instance_id) or not raw['licenseRevision'] or datetime.fromisoformat(raw['expiresAt'])<=datetime.now(UTC):raise ValueError()
        if host is not None and raw['host']!=host or purpose is not None and raw.get('purpose')!=purpose:raise ValueError()
        if type(raw['port']) is not int or not 1<=raw['port']<=65535 or not isinstance(raw['addresses'],list) or not 1<=len(raw['addresses'])<=32:raise ValueError()
        from .provider_setting_transport import private_model_address
        for value in raw['addresses']:
            address=ipaddress.ip_address(value)
            if not address.is_global and not (raw.get('allowPrivate') is True and private_model_address(value)) or address.is_link_local or address.is_multicast or address.is_unspecified:raise ValueError()
        if not isinstance(raw['host'],str) or not raw['host'] or any(char in raw['host'] for char in '/?#@\r\n'):raise ValueError()
    except (ValueError,TypeError,KeyError):raise HTTPException(422,'目标、本人、实例、许可或固定地址无效') from None
    return copy.deepcopy(raw)


def validate_models(values,who,settings):
    services=values.get('modelServices',[])
    if not isinstance(services,list) or len(services)>30:raise HTTPException(422,'模型服务过多')
    seen=set()
    for service in services:
        if not isinstance(service,dict) or set(service)-{'id','name','provider','apiUrl','apiKey','models','selectedModel','icon','icons','providerConfigs','approval'} or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',service.get('id','')) or service['id'] in seen or service.get('provider') not in ('deepseek','openai','jev','custom'):raise HTTPException(422,'模型服务标识或提供商无效')
        seen.add(service['id']);url=urlsplit(service.get('apiUrl',''))
        if url.scheme not in ('https','http') or url.username or url.password or url.query or url.fragment or not url.hostname:raise HTTPException(422,'模型入口须为固定HTTPS目标')
        if not isinstance(service.get('models',[]),list) or len(service.get('models',[]))>100 or any(not isinstance(value,str) or not 1<=len(value)<=160 for value in service.get('models',[])):raise HTTPException(422,'模型列表无效')
        if service.get('selectedModel') and service['selectedModel'] not in service.get('models',[]):raise HTTPException(422,'所选模型不属于已登记列表')
        licensed=approval(service.get('approval'),who,settings,host=url.hostname,purpose='provider.model.test')
        if url.scheme=='http' and not (licensed.get('allowPrivate') is True and licensed.get('allowPlaintext') is True):raise HTTPException(422,'明文私网模型须两项明确许可')
        if licensed.get('port')!=(url.port or (443 if url.scheme=='https' else 80)):raise HTTPException(422,'模型入口端口不符')
        # apiUrl is the base; an approval may pin the concrete chat-completions action.
        if licensed.get('path') not in (url.path,url.path.rstrip('/')+'/chat/completions'):raise HTTPException(422,'模型入口路径与许可不一致')
        from .provider_setting_transport import approved_model_target
        approved_model_target(url.scheme+'://'+url.netloc+licensed['path'],licensed,licensed['addresses'])
        if 'providerConfigs' in service:
            if not isinstance(service['providerConfigs'],dict):raise HTTPException(422,'模型提供商分配置无效')
            for provider,config in service['providerConfigs'].items():
                if provider not in ('deepseek','openai','jev','custom') or not isinstance(config,dict)or set(config)-{'apiUrl','apiKey','models','selectedModel','approval'}:raise HTTPException(422,'模型提供商分配置无效')
                if not isinstance(config.get('models',[]),list)or len(config.get('models',[]))>100 or any(not isinstance(m,str)or not 1<=len(m)<=160 for m in config.get('models',[])):raise HTTPException(422,'提供商分模型列表无效')
                if config.get('selectedModel')and config['selectedModel']not in config.get('models',[]):raise HTTPException(422,'提供商分模型选择无效')
                if config.get('apiKey')or config.get('approval'):
                    validate_models({'modelServices':[{'id':service['id'],'provider':provider,'apiUrl':config.get('apiUrl',service['apiUrl']),'apiKey':config.get('apiKey',''),'models':config.get('models',[]),'selectedModel':config.get('selectedModel',''),'approval':config.get('approval')or service['approval']}]},who,settings)
    active=values.get('activeModelServiceId','')
    if active and active not in seen:raise HTTPException(422,'当前模型服务标识不存在')


def validate_group(group,values,who,settings):
    if set(values)-set(GROUP_FIELDS[group]):raise HTTPException(422,'私有配置字段不属于该服务')
    if group=='smtp':
        enabled=values.get('smtpEnabled',False)
        if type(enabled) is not bool or type(values.get('smtpSecure')) is not bool:raise HTTPException(422,'SMTP开关或TLS选项无效')
        if type(values.get('smtpPort')) is not int or not 1<=values['smtpPort']<=65535:raise HTTPException(422,'SMTP端口无效')
        for key in ('smtpHost','smtpFromName','smtpFromEmail','emailLinkOrigin'):
            if not isinstance(values.get(key),str) or len(values[key])>500 or any(ord(char)<32 for char in values[key]):raise HTTPException(422,'邮件字段无效')
        if bool(values.get('smtpUser'))!=bool(values.get('smtpPassword')):raise HTTPException(422,'SMTP用户名和密码须同时设置或清除')
        if enabled:
            licensed=approval(values.get('smtpApproval'),who,settings,host=values['smtpHost'],purpose='smtp.send')
            licensed.setdefault('mode','tls' if values['smtpSecure'] else 'starttls');values['smtpApproval']=licensed
            if licensed['port']!=values['smtpPort'] or licensed.get('mode','tls' if values['smtpSecure'] else 'starttls')!=('tls' if values['smtpSecure'] else 'starttls'):raise HTTPException(422,'SMTP TLS或端口与许可不符')
            if not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+',values['smtpFromEmail']):raise HTTPException(422,'发件地址无效')
        if values.get('emailLinkOrigin'):
            link=urlsplit(values['emailLinkOrigin'])
            if link.scheme!='https' or not link.hostname or link.username or link.password or link.path or link.query or link.fragment:raise HTTPException(422,'邮件链接来源须为明确HTTPSOrigin')
            if values['emailLinkOrigin']!=settings.public_origin:raise HTTPException(422,'邮件链接来源尚未绑定当前公开Origin，不能只保存未消费的新域名')
        timeout=values.get('mailTimeout',10)
        if type(timeout) not in (int,float) or not 1<=timeout<=30:raise HTTPException(422,'邮件超时预算无效')
    elif group=='models':validate_models(values,who,settings)
    elif group in ('sources','notifications'):
        from .dividend_sources import Target
        from .market_authority import Policy, valid_source_symbols
        for key,rows in values.items():
            if key=='legacyChannelSettings':
                from .legacy_notification_settings import validate
                validate(values[key]);continue
            if key in ('quoteSource','peopleRefreshIntervals','translationEnabled','translationProvider','translationApiUrl','translationApproval','public_ticker'):continue
            if not isinstance(rows,list) or len(rows)>100:raise HTTPException(422,'安装目标列表无效或过多')
            seen=set()
            for target in rows:
                if not isinstance(target,dict) or not isinstance(target.get('id'),str) or target['id'] in seen:raise HTTPException(422,'安装目标标识无效或重复')
                seen.add(target['id'])
                if any(sensitive_url(value) for value in target.values() if isinstance(value,str)):raise HTTPException(422,'目标URL不得携带明文凭据，请使用领域密封凭据')
                owner=target.get('ownerId',target.get('owner_id'))
                if owner is not None and owner!=who.id and not any(old==target for old in base_snapshot(settings).get(group,{}).get(key,[])):raise HTTPException(403,'不能更改其他本人的来源归属')
                instance=target.get('instanceId',target.get('instance_id'))
                if instance is not None and str(instance)!=str(settings.instance_id):raise HTTPException(422,'目标实例不符')
                if key=='market_data_policies':
                    try:
                        policy=Policy(**target)
                        if not valid_source_symbols(policy):raise ValueError()
                    except (TypeError,ValueError):raise HTTPException(422,'行情策略字段无效') from None
                elif key=='dividend_source_targets':
                    try:Target(**target).validate(settings.environment)
                    except (TypeError,ValueError):raise HTTPException(422,'行情源固定目标无效') from None
                elif target.get('approvedAccess') is True:
                    if not target.get('licenseRevision') or not target.get('purpose') and not target.get('purposes'):raise HTTPException(422,'已批准目标必须明确许可与用途')
                    try:
                        if datetime.fromisoformat(target['expiresAt'])<=datetime.now(UTC):raise ValueError()
                    except (ValueError,TypeError,KeyError):raise HTTPException(422,'安装目标许可到期或缺失') from None
        intervals=values.get('peopleRefreshIntervals',{})
        if not isinstance(intervals,dict)or set(intervals)-{'trump','duan'}or any(type(v)is not int or not 1<=v<=1440 for v in intervals.values()):raise HTTPException(422,'人物刷新分钟无效')
        if group=='sources'and intervals:
            for target in values.get('feed_targets',[]):
                if target.get('ownerId')==who.id and target.get('personId')in intervals:target['refreshMinutes']=intervals[target['personId']]
        if values.get('quoteSource')not in (None,'auto','futu','tencent'):raise HTTPException(422,'行情提供商选择无效')
        if values.get('quoteSource')in ('futu','tencent')and not any(p.get('source')==values['quoteSource']and p.get('owner_id')==who.id and 'latest'in p.get('purposes',[])for p in values.get('market_data_policies',[])):raise HTTPException(409,'行情选择须有本人明确已许可的提供商策略')
        if values.get('translationEnabled'):
            if values.get('translationProvider')=='mymemory':
                licensed=approval(values.get('translationApproval'),who,settings,purpose='feed.translate')
                if values.get('translationApiUrl')!='https://api.mymemory.translated.net/get' or licensed['host']!='api.mymemory.translated.net' or licensed['port']!=443:raise HTTPException(422,'翻译须为已实现且明确许可的固定提供商')
            else:
                candidates=[target for target in values.get('feed_model_targets',[]) if target.get('purpose')=='feed.translate' and target.get('provider')==values.get('translationProvider')]
                if len(candidates)!=1 or values.get('translationProvider')not in {'deepseek','openai','custom'}:raise HTTPException(422,'翻译须对应唯一已安装且已实现的文本提供商目标')
                from types import SimpleNamespace
                from .feed_model import FeedModel
                from .feed_model_chat import endpoint
                selected=FeedModel(SimpleNamespace(settings=SimpleNamespace(instance_id=settings.instance_id,feed_model_targets=values['feed_model_targets']))).target(who.id,candidates[0]['id'],purpose='feed.translate')
                actual,_=endpoint(selected)
                if values.get('translationApiUrl')not in (actual,actual.removesuffix('/chat/completions')):raise HTTPException(422,'翻译入口与已许可文本目标不符')
    elif group=='scheduling':
        if type(values.get('worker_poll_seconds')) not in (int,float) or not 0.1<=values['worker_poll_seconds']<=30 or type(values.get('lease_seconds')) is not int or not 10<=values['lease_seconds']<=300:raise HTTPException(422,'Worker调度预算无效')
    elif group=='cookies':
        if not isinstance(values.get('xueqiuCookieTargetId'),str):raise HTTPException(422,'Cookie须关联明确雪球目标')
        cookie=values.get('xueqiuCookie','')
        if not isinstance(cookie,str) or len(cookie.encode())>16384 or '\r' in cookie or '\n' in cookie:raise HTTPException(422,'Cookie内容无效')


async def installed(conn):
    row=await(await conn.execute("SELECT to_regclass('public.private_runtime_scope') AS table_name,EXISTS(SELECT 1 FROM schema_migrations WHERE name='0131_private_runtime_settings.sql') AS marker")).fetchone()
    if bool(row['table_name'])!=bool(row['marker']):return False,'schema_incomplete'
    return bool(row['table_name']),None


class PrivateRuntimeSettings:
    def __init__(self,db):self.db=db

    async def rows(self,conn):
        ready,reason=await installed(conn)
        if reason:return 0,[],{'schema':reason}
        if not ready:return 0,[],{}
        current=await(await conn.execute('SELECT revision FROM private_runtime_scope WHERE singleton')).fetchone()
        rows=await(await conn.execute('SELECT v.*,h.managed_fields,h.managed_targets FROM private_runtime_heads h JOIN private_runtime_versions v ON v.id=h.current_version ORDER BY v.group_name')).fetchall()
        return current['revision'] if current else 0,rows,{}

    def decrypt(self,row):
        if str(row['crypto_instance'])!=str(self.db.settings.instance_id):raise HTTPException(503,'私有配置须在当前实例重新批准')
        try:
            key=NotificationSecurity(self.db).existing_key()
            envelope=json.loads(Fernet(key).decrypt(row['payload_ciphertext'].encode()))
            if envelope['kind']!='private-runtime:'+row['group_name']+':'+str(row['revision']) or envelope['instance']!=str(self.db.settings.instance_id):raise ValueError()
            value=json.loads(envelope['password'])
            if not isinstance(value,dict):raise TypeError()
            return value
        except (InvalidToken,ValueError,TypeError,KeyError):raise HTTPException(503,'私有配置不可解密，等待管理员重新批准') from None

    async def private_on_connection(self,conn):
        revision,rows,failures=await self.rows(conn);groups=base_snapshot(self.db.settings)
        for row in rows:
            try:groups[row['group_name']]=self.decrypt(row)
            except HTTPException:groups[row['group_name']]={};failures[row['group_name']]='sealed_unavailable'
        result={key:value for values in groups.values() for key,value in values.items()}
        result['modelServicesRevision']=revision;result['_unavailableGroups']=failures
        return revision,result

    async def read_admin(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            revision,rows,failures=await self.rows(conn);values=base_snapshot(self.db.settings);saved=set()
            for row in rows:
                saved.add(row['group_name'])
                try:
                    values[row['group_name']]=self.decrypt(row)
                    from types import SimpleNamespace
                    try:validate_group(row['group_name'],values[row['group_name']],SimpleNamespace(id=row['actor_id']),self.db.settings)
                    except HTTPException:failures[row['group_name']]='approval_unavailable_requires_reapproval'
                except HTTPException:values[row['group_name']]={};failures[row['group_name']]='sealed_unavailable'
            groups={}
            for group,data in values.items():
                states={};visible=redact(data,states=states)
                groups[group]={'values':visible,'secretState':states,'state':'unavailable' if group in failures else 'saved' if group in saved else 'installation','schema':[{'key':key,'type':'list' if key in SOURCE_FIELDS and key!='public_ticker' or key in ('modelServices','business_notification_targets') else 'object' if key.endswith('Approval') or key in ('public_ticker','legacyChannelSettings','peopleRefreshIntervals') else 'boolean' if key in ('smtpEnabled','smtpSecure','translationEnabled') else 'number' if key in ('smtpPort','mailTimeout','worker_poll_seconds','lease_seconds') else 'string'} for key in GROUP_FIELDS[group] if not key.startswith('_') and not is_secret(key)]}
            return {'revision':revision,'groups':groups,'unavailable':failures,'consumerState':'configuration_only_not_delivery_health'}

    async def save(self,who,raw,*,connection=None,verified_factor=None):
        if not isinstance(raw,dict) or set(raw)-{'requestId','expectedRevision','group','patch','secretActions','password','code','replaceUnavailable'}:raise HTTPException(422,'私有配置请求字段无效')
        try:rid=str(UUID(raw['requestId']))
        except (ValueError,TypeError,KeyError):raise HTTPException(422,'需要原请求UUID') from None
        group=raw.get('group');expected=raw.get('expectedRevision');patch=raw.get('patch',{});actions=raw.get('secretActions',{})
        if group not in GROUP_FIELDS or not isinstance(patch,dict) or set(patch)-set(GROUP_FIELDS[group]) or any(key.startswith('_') for key in patch) or not isinstance(actions,dict) or type(expected) is not int:raise HTTPException(422,'私有服务、字段或当前修订无效')
        try:hashed=NotificationSecurity(self.db).mac({key:value for key,value in raw.items() if key not in ('password','code')},create=True)
        except (ValueError,TypeError,UnicodeError):raise HTTPException(422,'私有配置内容无效') from None
        from .broker_accounts import broker_connection
        async with broker_connection(self.db,connection) as conn,conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
            await lock_mutation_identity(conn,who)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('private-runtime-settings',0))")
            ready,reason=await installed(conn)
            if not ready or reason:raise HTTPException(503,'私有配置迁移尚未完整安装')
            prior=await(await conn.execute('SELECT fingerprint,result FROM private_runtime_operations WHERE actor_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                if prior['fingerprint']!=hashed:raise HTTPException(409,'原UUID已用于不同配置')
                return prior['result']
            current=await(await conn.execute('SELECT revision FROM private_runtime_scope WHERE singleton FOR UPDATE')).fetchone()
            if not current or current['revision']!=expected:raise HTTPException(409,'私有配置修订已变化')
            if raw.get('password'):
                password,code=raw['password'],raw.get('code','')
                if not isinstance(password,str) or not isinstance(code,str):raise HTTPException(422,'身份核对字段无效')
                checked=await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
                verified_factor=(conn,who.id,who.token_hash,checked)
            elif raw.get('code'):raise HTTPException(422,'验证码需与本次密码核对一同提供')
            previous=await(await conn.execute('SELECT v.* FROM private_runtime_heads h JOIN private_runtime_versions v ON v.id=h.current_version WHERE h.group_name=%s',(group,))).fetchone()
            values=base_snapshot(self.db.settings)[group]
            if previous:
                try:values=self.decrypt(previous)
                except HTTPException:
                    if raw.get('replaceUnavailable') is not True:raise HTTPException(409,'原密封配置不可用；须明确重新填写并批准替换') from None
                    values={}
            previous_values=copy.deepcopy(values)
            values=merge_nonsecret(values,patch)
            for path,action in actions.items():
                if not isinstance(path,str) or not isinstance(action,dict) or set(action)-{'action','value'} or action.get('action') not in ('keep','set','clear'):raise HTTPException(422,'秘密动作无效')
                target,key=locate(values,path)
                if action['action']=='keep':continue
                if group in ('sources','notifications') and key!='credentialCiphertext':
                    from .legacy_notification_settings import KEYS
                    if not(group=='notifications'and path.startswith('legacyChannelSettings.')and key in KEYS):raise HTTPException(422,'此类秘密须由已有领域凭据绑定入口保存')
                secret=action.get('value') if action['action']=='set' else ''
                if not isinstance(secret,str) or len(secret.encode())>16384 or '\r' in secret or '\n' in secret:raise HTTPException(422,'秘密值无效')
                if key=='credentialCiphertext' and secret:
                    collection=path.split('.')[0];identifier=target.get('id')
                    prefixes={'feed_model_targets':'feed-model:','record_ocr_targets':'record-ocr:','card_ocr_targets':'card-ocr:','feed_targets':'feed-source:'}
                    if collection not in prefixes or not identifier:raise HTTPException(422,'此凭据须由所属领域确认')
                    envelope={'kind':prefixes[collection]+identifier,'instance':str(self.db.settings.instance_id),'password':secret}
                    if collection=='feed_targets' and target.get('provider')=='xueqiu-status-json':envelope['host']='api.xueqiu.com'
                    secret=Fernet(Vault(self.db.settings.connection_secret_dir).key()).encrypt(canonical(envelope).encode()).decode()
                target[key]=secret
            if group=='smtp'and previous_values.get('smtpPassword'):
                endpoint=lambda v:(str(v.get('smtpHost')or'').strip().lower().rstrip('.'),v.get('smtpPort'),v.get('smtpSecure'),str(v.get('smtpUser')or'').strip())
                password_action=actions.get('smtpPassword',{}).get('action')
                if endpoint(values)!=endpoint(previous_values)and password_action not in ('set','clear'):raise HTTPException(422,'SMTP地址或账号已更改，请明确输入新密码或清除原凭据')
            validate_group(group,values,who,self.db.settings)
            if group=='cookies' and not values.get('xueqiuCookie'):values.pop('_xueqiuCredentialCiphertext',None)
            if group=='models':
                from .celeb_core import asset_reference
                for model in values.get('modelServices',[]):
                    if model.get('icon'):model['icon']=await asset_reference(conn,model['icon'])
                    if model.get('icons'):
                        if not isinstance(model['icons'],dict):raise HTTPException(422,'模型图标映射无效')
                        model['icons']={key:await asset_reference(conn,value) for key,value in model['icons'].items()}
            if group=='cookies' and values.get('xueqiuCookie'):
                _,private=await self.private_on_connection(conn)
                targets=private.get('feed_targets',[])
                matches=[row for row in targets if row.get('id')==values['xueqiuCookieTargetId']]
                if len(matches)!=1 or matches[0].get('provider')!='xueqiu-status-json' or matches[0].get('ownerId')!=who.id or str(matches[0].get('instanceId'))!=str(self.db.settings.instance_id) or urlsplit(matches[0].get('url','')).hostname!='api.xueqiu.com':raise HTTPException(422,'Cookie必须关联本人当前实例已装雪球固定目标')
                envelope={'kind':'feed-source:'+values['xueqiuCookieTargetId'],'instance':str(self.db.settings.instance_id),'password':values['xueqiuCookie'],'host':'api.xueqiu.com'}
                values['_xueqiuCredentialCiphertext']=Fernet(Vault(self.db.settings.connection_secret_dir).key()).encrypt(canonical(envelope).encode()).decode()
            channel_effects=[]
            if group=='notifications'and 'legacyChannelSettings'in values:
                from .legacy_notification_settings import apply
                from .market_worker import Bound
                channel_effects=await apply(conn,Bound(conn,self.db.settings),who,rid,previous_values,values,verified_factor=verified_factor)
            next_revision=expected+1;identifier=uuid4()
            cipher=Vault(self.db.settings.connection_secret_dir).encrypt(canonical(values),'private-runtime:'+group+':'+str(next_revision),self.db.settings.instance_id)
            await conn.execute('INSERT INTO private_runtime_versions(id,group_name,revision,payload_ciphertext,crypto_instance,actor_id,request_id) VALUES(%s,%s,%s,%s,%s,%s,%s)',(identifier,group,next_revision,cipher,self.db.settings.instance_id,who.id,rid))
            targets=[values['xueqiuCookieTargetId']] if group=='cookies' and values.get('xueqiuCookieTargetId') else []
            await conn.execute('INSERT INTO private_runtime_heads(group_name,current_version,managed_fields,managed_targets) VALUES(%s,%s,%s,%s) ON CONFLICT(group_name) DO UPDATE SET current_version=excluded.current_version,managed_fields=excluded.managed_fields,managed_targets=excluded.managed_targets',(group,identifier,list(values),targets))
            await conn.execute('UPDATE private_runtime_scope SET revision=%s WHERE singleton',(next_revision,))
            states={};visible=redact(values,states=states)
            result={'requestId':rid,'state':'completed','revision':next_revision,'group':group,'values':visible,'secretState':states,'runtimeState':'saved_pending_consumer_refresh','deliveryHealth':'not_tested','channelEffects':channel_effects}
            await conn.execute('INSERT INTO private_runtime_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,rid,hashed,Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'private-runtime.saved',%s,%s)",(who.id,group,rid))
            return result

    async def receipt(self,who,request_id):
        try:request_id=UUID(str(request_id))
        except (ValueError,TypeError):raise HTTPException(422,'原请求编号无效') from None
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            row=await(await conn.execute('SELECT result FROM private_runtime_operations WHERE actor_id=%s AND request_id=%s',(who.id,request_id))).fetchone()
            if not row:raise HTTPException(404,'原配置回执不存在')
            return row['result']

    async def save_legacy(self,who,raw,request_id,expected_revision,connection=None,*,password="",code="",verifier=None):
        from uuid import uuid5

        from .broker_accounts import broker_connection
        from .market_worker import Bound
        if not isinstance(raw,dict):raise HTTPException(422,'私有配置无效')
        raw=copy.deepcopy(raw)
        for key in list(raw):
            if key.endswith('Configured')or key in {'modelServicesInitialized','modelServicesError'}:raw.pop(key) # original read-only projection flags
        if isinstance(raw.get('smtpPort'),str):
            if not re.fullmatch(r'[0-9]{1,5}',raw['smtpPort']):raise HTTPException(422,'SMTP端口无效')
            raw['smtpPort']=int(raw['smtpPort'])
        if raw.get('translationProvider')=='openai-compatible':raw['translationProvider']='custom'
        async with broker_connection(self.db,connection) as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('private-runtime-settings',0))")
            revision,private=await self.private_on_connection(conn)
            if raw.get('clearXueqiuCookie') is True and isinstance(raw.get('xueqiuCookie'),str)and raw['xueqiuCookie'].strip():raise HTTPException(422,'不能同时替换和清除Cookie')
            if raw.get('xueqiuCookie')not in (None,'','********')and not raw.get('xueqiuCookieTargetId'):
                selected=private.get('xueqiuCookieTargetId')
                if not selected:
                    candidates=[t for t in private.get('feed_targets',[])if t.get('provider')=='xueqiu-status-json'and t.get('ownerId')==who.id and str(t.get('instanceId'))==str(self.db.settings.instance_id)and urlsplit(t.get('url','')).hostname=='api.xueqiu.com']
                    if len(candidates)!=1:raise HTTPException(409,'Cookie须关联唯一已安装本人雪球来源')
                    selected=candidates[0]['id']
                raw['xueqiuCookieTargetId']=selected
            expected=expected_revision if expected_revision is not None else revision
            interval_keys={'tradingSquareTrumpRefreshMinutes':'trump','tradingSquareDuanRefreshMinutes':'duan'}
            interval_changes={key:raw.pop(key)for key in list(raw)if key in interval_keys}
            groups={};secrets={};unhandled=[]
            if interval_changes:
                import math
                intervals=copy.deepcopy(private.get('peopleRefreshIntervals',{}))
                for key,value in interval_changes.items():
                    if type(value)not in (int,float)or not math.isfinite(value):raise HTTPException(422,'人物刷新分钟无效')
                    intervals[interval_keys[key]]=min(1440,max(1,math.floor(value+0.5)))
                groups['sources']={'peopleRefreshIntervals':intervals}
            from .legacy_notification_settings import KEYS as SOCIAL_KEYS
            social={key:raw.pop(key)for key in list(raw)if key in SOCIAL_KEYS}
            verified_factor=None
            if social and password:
                checked=await verifier.step_up(conn,who,password,code) if verifier else await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
                verified_factor=(conn,who.id,who.token_hash,checked)
            if social:
                metadata={}
                for key,value in social.items():
                    if is_secret(key):secrets.setdefault('notifications',{})['legacyChannelSettings.'+key]={'action':'set','value':value}if value and value!='********'else{'action':'keep'}
                    else:metadata[key]=value
                groups['notifications']={'legacyChannelSettings':metadata}

            for key,value in raw.items():
                matching=[group for group,keys in GROUP_FIELDS.items() if key in keys and not key.startswith('_')]
                if not matching:unhandled.append(key);continue
                group=matching[0]
                if is_secret(key):
                    secrets.setdefault(group,{})[key]={'action':'set','value':value} if value and value!='********' else {'action':'keep'}
                else:groups.setdefault(group,{})[key]=value
            if 'smtp' in groups and 'smtpEnabled'not in raw:
                candidate={**private,**groups['smtp']}
                declared=candidate.get('smtpApproval')or{}
                # Old SMTP configuration had no enabled flag: a complete match
                # to an already-approved installation is the explicit save intent.
                groups['smtp']['smtpEnabled']=bool(candidate.get('smtpHost')and candidate.get('smtpFromEmail')and declared.get('approvedAccess')is True and declared.get('host')==candidate.get('smtpHost')and declared.get('port')==candidate.get('smtpPort'))
            if 'modelServices' in raw:
                def strip(value,path):
                    if isinstance(value,dict):
                        result={}
                        for key,item in value.items():
                            if key.endswith('Configured'):continue  # old read-only secret-presence flags are never credentials
                            location=path+'.'+key
                            if is_secret(key):secrets.setdefault('models',{})[location]={'action':'set','value':item} if item and item!='********' else {'action':'keep'}
                            else:result[key]=strip(item,location)
                        return result
                    if isinstance(value,list):return [strip(item,path+'.'+str(item.get('id',index))) if isinstance(item,dict) else item for index,item in enumerate(value)]
                    return value
                groups.setdefault('models',{})['modelServices']=strip(raw['modelServices'],'modelServices')
            # The old single-provider aliases address a unique configured service;
            # they never create an unapproved destination or choose an arbitrary first row.
            aliases={'deepseekApiUrl':'apiUrl','deepseekModel':'selectedModel','deepseekApiKey':'apiKey','llmApiUrl':'apiUrl','llmModel':'selectedModel','llmApiKey':'apiKey'}
            alias_keys=set(raw)&set(aliases)
            if alias_keys or 'llmProvider' in raw:
                services=copy.deepcopy(groups.get('models',{}).get('modelServices',private.get('modelServices',[])))
                provider=raw.get('llmProvider','deepseek')
                candidates=[service for service in services if service.get('provider')==provider]
                if len(candidates)!=1:raise HTTPException(409,'旧模型别名须唯一明确的已安装提供商服务')
                selected=candidates[0]
                for key in alias_keys:
                    target=aliases[key]
                    if target=='apiKey':secrets.setdefault('models',{})['modelServices.'+selected['id']+'.apiKey']={'action':'set','value':raw[key]} if raw[key] and raw[key]!='********' else {'action':'keep'}
                    else:
                        selected[target]=raw[key]
                        if target=='selectedModel'and raw[key]not in selected.get('models',[]):selected['models']=[*selected.get('models',[]),raw[key]]
                for service in services:
                    service.pop('apiKey',None)
                groups.setdefault('models',{})['modelServices']=services
                groups['models']['activeModelServiceId']=selected['id']
                unhandled=[key for key in unhandled if key not in alias_keys and key!='llmProvider']
            futu_keys=set(raw)&{'futuHost','futuPort'}
            if futu_keys:
                from .dividend_sources import Target
                targets=copy.deepcopy(private.get('dividend_source_targets',[]));policies=copy.deepcopy(private.get('market_data_policies',[]))
                available=[target for target in targets if target.get('source')=='futu']
                if len(available)!=1:raise HTTPException(409,'旧富途字段须对应唯一已安装富途目标')
                selected=available[0]
                if 'futuHost' in raw:selected['host']=raw['futuHost']
                if 'futuPort' in raw:
                    try:selected['port']=int(raw['futuPort'])
                    except (ValueError,TypeError):raise HTTPException(422,'富途端口无效') from None
                try:target=Target(**selected).validate(self.db.settings.environment)
                except (ValueError,TypeError):raise HTTPException(422,'富途固定目标或明文许可无效') from None
                for policy in policies:
                    if policy.get('target_id')==target.id:
                        if policy.get('owner_id')!=who.id:raise HTTPException(403,'不能用旧字段改写其他本人来源')
                        policy['target_fingerprint']=target.fingerprint
                groups.setdefault('sources',{}).update(dividend_source_targets=targets,market_data_policies=policies)
                unhandled=[key for key in unhandled if key not in futu_keys]
            url_groups={'currencyApiUrl':'fx_provider_targets','earningsApiUrl':'earnings_targets','cnEarningsApiUrl':'earnings_targets','hkEarningsApiUrl':'earnings_targets','quoteApiUrl':'dividend_source_targets','chartApiUrl':'dividend_source_targets','searchApiUrl':'market_discovery_targets','usLogoApiUrl':'asset_source_targets','cnLogoApiUrl':'asset_source_targets','trumpArchiveApiUrl':'feed_targets'}
            for key,collection in url_groups.items():
                if key not in raw:continue
                targets=groups.get('sources',{}).get(collection,private.get(collection,[]))
                matches=[target for target in targets if raw[key] in (target.get('url'),target.get('apiUrl'),target.get('endpoint'))or key=='quoteApiUrl'and target.get('source')=='tencent'and raw[key]=='https://qt.gtimg.cn/q='and target.get('host')=='qt.gtimg.cn'and target.get('scheme','https')=='https']
                if len(matches)!=1:raise HTTPException(422,'该旧URL须先登记为唯一已实现协议与明确许可目标：'+key)
                groups.setdefault('sources',{})[collection]=targets
                unhandled=[field for field in unhandled if field!=key]
            if 'clearXueqiuCookie' in raw:
                if type(raw['clearXueqiuCookie']) is not bool:raise HTTPException(422,'清除Cookie须为明确开关')
                unhandled=[key for key in unhandled if key!='clearXueqiuCookie']
                if raw['clearXueqiuCookie']:
                    target=raw.get('xueqiuCookieTargetId') or private.get('xueqiuCookieTargetId')
                    if not target:
                        matches=[item for item in private.get('feed_targets',[]) if item.get('provider')=='xueqiu-status-json' and item.get('ownerId')==who.id and str(item.get('instanceId'))==str(self.db.settings.instance_id) and urlsplit(item.get('url','')).hostname=='api.xueqiu.com']
                        if len(matches)!=1:raise HTTPException(409,'须明确唯一已登记的本人雪球目标')
                        target=matches[0]['id']
                    groups.setdefault('cookies',{})['xueqiuCookieTargetId']=target
                    secrets.setdefault('cookies',{})['xueqiuCookie']={'action':'clear'}
            if unhandled:raise HTTPException(422,'字段须由已有专属配置权威保存：'+','.join(sorted(unhandled)))
            outputs=[];service=PrivateRuntimeSettings(Bound(conn,self.db.settings))
            for group in sorted(set(groups)|set(secrets)):
                child=str(uuid5(UUID(str(request_id)),'private-runtime:'+group))
                result=await service.save(who,{'requestId':child,'expectedRevision':expected,'group':group,'patch':groups.get(group,{}),'secretActions':secrets.get(group,{})},connection=conn,verified_factor=verified_factor)
                expected=result['revision'];outputs.append(result)
            enrollment=[]
            if interval_changes:
                from .feed_refresh_policy import enroll_changed
                _,effective=await self.private_on_connection(conn)
                enrollment=await enroll_changed(conn,self.db,who,request_id,effective)
            return {'requestId':str(request_id),'state':'completed','revision':expected,'groups':outputs,'peopleScheduleEnrollment':enrollment}


def seal_runtime_values(value):
    if isinstance(value,list):return [seal_runtime_values(item) for item in value]
    if isinstance(value,dict):return {key:(SecretStr(item) if is_secret(key) and isinstance(item,str) and item else seal_runtime_values(item)) for key,item in value.items()}
    return value


def assign(settings,name,value):object.__setattr__(settings,name,value)


def apply_group(settings,group,values):
    if group=='smtp':
        for key,attribute in SMTP_MAP.items():
            value=values.get(key)
            if key=='smtpSecure':value='tls' if value else 'starttls'
            if key in ('smtpUser','smtpPassword'):value=SecretStr(value) if value else None
            assign(settings,attribute,copy.deepcopy(value))
    elif group=='models':
        assign(settings,'provider_model_targets',seal_runtime_values(copy.deepcopy(values.get('modelServices',[]))))
        assign(settings,'active_model_service_id',values.get('activeModelServiceId',''))
    elif group in ('sources','notifications','scheduling'):
        for key,value in values.items():
            if key in SOURCE_FIELDS or key in ('business_notification_targets','worker_poll_seconds','lease_seconds'):assign(settings,key,copy.deepcopy(value))
        if group=='sources':assign(settings,'_legacy_quote_source',values.get('quoteSource'))
        if group=='sources' and 'translationEnabled' in values:
            current=[target for target in settings.feed_model_targets if target.get('purpose')!='feed.translate']
            if values['translationEnabled'] and values.get('translationProvider')in {'deepseek','openai','custom'}:
                current.extend(target for target in values.get('feed_model_targets',[]) if target.get('purpose')=='feed.translate' and target.get('provider')==values.get('translationProvider'))
            elif values['translationEnabled']:
                source=values['translationApproval']
                current.append({'id':'runtime-translation','provider':'mymemory','purpose':'feed.translate','model':'mymemory',
                    **{key:source[key] for key in ('ownerId','instanceId','approvedAccess','host','addresses','licenseRevision','expiresAt')},'publicDisplay':source.get('publicDisplay') is True})
            assign(settings,'feed_model_targets',current)
    elif group=='cookies':
        selected=values.get('xueqiuCookieTargetId');cipher=values.get('_xueqiuCredentialCiphertext')
        targets=copy.deepcopy(settings.feed_targets)
        for target in targets:
            if target.get('id')==selected:
                if cipher:target['credentialCiphertext']=cipher
                else:target.pop('credentialCiphertext',None)
        if selected and not cipher:targets=[target for target in targets if target.get('id')!=selected]
        assign(settings,'feed_targets',targets)


def disable_group(settings,group,fields=(),targets=()):
    if group=='smtp':assign(settings,'mail_enabled',False);assign(settings,'mail_delivery_policy',{'state':'sealed_unavailable'})
    elif group=='models':assign(settings,'provider_model_targets',[]);assign(settings,'active_model_service_id','')
    elif group=='cookies':assign(settings,'feed_targets',[row for row in settings.feed_targets if row.get('id') not in targets and (targets or row.get('provider')!='xueqiu-status-json')])
    elif group in ('sources','notifications'):
        for field in fields:
            if field in SOURCE_FIELDS or field=='business_notification_targets':assign(settings,field,{} if field=='public_ticker' else [])
    # Invalid scheduling never blocks service repair or reuses an unsafe persisted budget.
    elif group=='scheduling':assign(settings,'worker_poll_seconds',1);assign(settings,'lease_seconds',30)


async def load_runtime_on_connection(conn,settings):
    # No new connection, key creation, provider IO, or mutation is permitted here.
    from types import SimpleNamespace
    service=PrivateRuntimeSettings(SimpleNamespace(settings=settings));base=base_snapshot(settings)
    revision,rows,failures=await service.rows(conn)
    if not rows and not failures:return {'revision':revision,'changed':False,'unavailable':{}}
    before=hashlib.sha256(canonical(primitive({group:{key:getattr(settings,SMTP_MAP.get(key,key),None) for key in values if key in SOURCE_FIELDS or key in SMTP_MAP or key in ('business_notification_targets','worker_poll_seconds','lease_seconds')} for group,values in base.items()})).encode()).hexdigest()
    for group,values in base.items():apply_group(settings,group,values)
    for row in sorted(rows,key=lambda row: list(GROUP_FIELDS).index(row['group_name']) if row['group_name'] in GROUP_FIELDS else -1):
        group=row['group_name']
        try:
            current_actor=await (await conn.execute("SELECT active,role,deleted_at FROM users WHERE id=%s",(row['actor_id'],))).fetchone()
            if not current_actor or not current_actor['active'] or current_actor['role']!='admin' or current_actor['deleted_at'] is not None:
                raise HTTPException(403,'Runtime approval owner is no longer authorized')
            values=service.decrypt(row)
            actor=SimpleNamespace(id=row['actor_id'])
            validate_group(group,values,actor,settings)
            apply_group(settings,group,values)
        except (HTTPException,ValueError,TypeError,KeyError):
            failures[group]='unavailable_requires_current_instance_reapproval'
            disable_group(settings,group,row['managed_fields'],row['managed_targets'])
    if 'schema' in failures:
        for group,values in base.items():disable_group(settings,group,list(values))
    previous_revision=getattr(settings,'_private_runtime_revision',None)
    previous_unavailable=getattr(settings,'_private_runtime_unavailable',None)
    object.__setattr__(settings,'_private_runtime_unavailable',dict(failures))
    object.__setattr__(settings,'_private_runtime_revision',revision)
    after=hashlib.sha256(canonical(primitive({group:{key:getattr(settings,SMTP_MAP.get(key,key),None) for key in values if key in SOURCE_FIELDS or key in SMTP_MAP or key in ('business_notification_targets','worker_poll_seconds','lease_seconds')} for group,values in base.items()})).encode()).hexdigest()
    return {'revision':revision,'changed':previous_revision!=revision or previous_unavailable!=failures or before!=after,'unavailable':failures}
