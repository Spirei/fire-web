"""Original social settings metadata, with actual credentials in existing Providers only.

No recipient is bound and no message/probe is issued while saving settings.
"""
import copy
import json
import re
from types import SimpleNamespace
from uuid import UUID,uuid5

from fastapi import HTTPException
from .notification_security import NotificationSecurity
from .notification_providers import Providers
from .price_alert_runtime import targets

FIELDS={
'wechat':('Enabled','Name','SmartRobot','CorpId','AgentId','Secret','ProxyUrl','Token','AesKey','AdminIds','Webhook'),
 'telegram':('Enabled','Name','Types','BotUsername','BotToken','ChatId','UserIds','AdminIds','ApiBase'),
 'feishu':('Enabled','Name','Types','AppId','AppSecret','OpenId','ChatId','AdminIds','VerificationToken','EncryptKey','Webhook'),
 'qq':('Enabled','Name','Types','AppId','AppSecret','UserOpenId','GroupOpenId','AdminIds'),
 'discord':('Enabled','Name','Types','BotToken','GuildId','ChannelId','AdminIds'),
 'webPush':('Enabled','Name','Types','Username')}
KEYS={p+s for p,parts in FIELDS.items()for s in parts}
CREDENTIALS={'wechat':{'CorpId':'corpId','AgentId':'agentId','Secret':'appSecret'},'telegram':{'BotToken':'botToken','BotUsername':'botUsername'},
 'feishu':{'AppId':'appId','AppSecret':'appSecret'},'qq':{'AppId':'appId','AppSecret':'appSecret'},'discord':{'BotToken':'botToken'}}


def validate(values):
    if not isinstance(values,dict)or set(values)-KEYS:raise HTTPException(422,'旧通知配置字段无效')
    for key,value in values.items():
        if key.endswith(('Enabled','SmartRobot')):
            if type(value)is not bool:raise HTTPException(422,'通知开关无效')
        elif not isinstance(value,str)or len(value.encode('utf-8'))>16384 or re.search(r'[\x00-\x1f\x7f]',value):raise HTTPException(422,'通知元数据无效')
    for prefix in FIELDS:
        name=values.get(prefix+'Name')
        if name is not None and len(name.encode('utf-16-le'))//2>40:raise HTTPException(422,'通知名称过长')
    if 'telegramBotUsername'in values:values['telegramBotUsername']=values['telegramBotUsername'].strip().removeprefix('@')
    for key in ('wechatAdminIds','telegramUserIds','telegramAdminIds'):
        if key in values:
            parts=[v for v in re.split(r'[,，\s]+',values[key])if v]
            if len(parts)>50 or any(not re.fullmatch(r'[A-Za-z0-9_@.:-]{1,64}',v)for v in parts):raise HTTPException(422,'通知白名单无效')
            values[key]=','.join(parts)
    return values


async def apply(conn,db,who,parent_id,previous,values,*,verified_factor=None):
    """Same-transaction bridge. A checked factor is internal, never HTTP-selectable."""
    metadata=validate(copy.deepcopy(values.get('legacyChannelSettings',{})))
    old=previous.get('legacyChannelSettings',{})
    installed=copy.deepcopy(values.get('business_notification_targets',[]))
    result=[]
    for prefix in FIELDS:
        channel='webpush'if prefix=='webPush'else prefix
        touched=any(metadata.get(prefix+s)!=old.get(prefix+s)for s in FIELDS[prefix])
        if not touched:continue
        choices=[v for v in installed if v.get('channel')==channel]
        requested=metadata.get(prefix+'Enabled')
        if len(choices)!=1:
            if requested is True:raise HTTPException(409,'须明确唯一已安装通知目标：'+channel)
            continue # Preserved disabled metadata is not a working provider.
        chosen=choices[0]
        if prefix+'Name'in metadata:chosen['label']=metadata[prefix+'Name'] or None
        if channel=='webpush':
            chosen['public_discovery']={'enabled':requested is True,'configured':requested is True and bool(metadata.get('webPushUsername'))}
            result.append({'channel':channel,'state':'discovery_only','bindable':False});continue
        service=Providers(db,targets(SimpleNamespace(business_notification_targets=installed)))
        current=await service.latest(conn,who.id,channel)
        enabled=requested if requested is not None else bool(current)
        if any(prefix+suffix in metadata and metadata[prefix+suffix]==''and old.get(prefix+suffix)not in (None,'')for suffix in CREDENTIALS[channel]):
            enabled=False;metadata[prefix+'Enabled']=False # explicit clear revokes the active credential, never just its display flag
        revoked=bool(current and await(await conn.execute('SELECT 1 FROM business_notification_provider_revocations WHERE owner_id=%s AND provider_revision=%s',(who.id,current['revision']))).fetchone())
        if not enabled and revoked:continue
        old_credentials={}
        if current:
            old_credentials=json.loads(service.security.decrypt(current['ciphertext'],'provider:'+str(current['revision'])))
        credentials=dict(old_credentials)
        for suffix,key in CREDENTIALS[channel].items():
            value=metadata.get(prefix+suffix)
            if value is not None and value not in ('','********'):
                if key=='agentId':
                    if not re.fullmatch(r'[0-9]{1,12}',value):raise HTTPException(422,'企业微信AgentId无效')
                    value=int(value)
                credentials[key]=value
        if not enabled and not current:continue
        target=service.target(chosen['id'],channel)
        if enabled and current and not revoked and current['target_fingerprint']==target.fingerprint and credentials==old_credentials:continue
        if not verified_factor or verified_factor[:3]!=(conn,who.id,who.token_hash):raise HTTPException(428,'更改通知凭据或启停须核对当前密码及安全因子')
        class CheckedFactor:
            def __init__(self,original):self.original=original
            def __getattr__(self,name):return getattr(self.original,name)
            async def step_up(self,c,actor,password,code):
                if c is not conn or actor.id!=who.id or actor.token_hash!=who.token_hash:raise HTTPException(403,'通知核对上下文已变化')
                return verified_factor[3]
        service.security.passkeys=CheckedFactor(service.security.passkeys)
        request_id=str(uuid5(UUID(str(parent_id)),'legacy-channel:'+channel))
        if enabled:
            operation={'requestId':request_id,'channel':channel,'targetId':chosen['id'],'expectedRevision':str(current['revision'])if current else None,'credentials':credentials}
        else:operation={'action':'provider_revoke','revision':str(current['revision']),'requestId':request_id}
        proof=await service.security.verify(who,{'operation':operation,'currentPassword':'internal-already-verified','code':''})
        effect=await service.configure(who,operation,proof['proofId'])if enabled else await service.revoke(who,str(current['revision']),request_id,proof['proofId'])
        result.append({'channel':channel,'operation':effect,'recipientBinding':'not_created','deliveryHealth':'not_checked'})
    values['legacyChannelSettings']=metadata;values['business_notification_targets']=installed
    return result
