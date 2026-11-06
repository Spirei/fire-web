"""Old read-only settings flags over already-redacted authoritative groups."""
import copy
from .legacy_notification_settings import KEYS
from .private_runtime_settings import is_secret


def project(groups):
    result={}
    for name,group in groups.items():
        values=copy.deepcopy(group['values']);states=group['secretState']
        result.update({key:value for key,value in values.items()if not key.startswith('_')})
        if name=='smtp'and type(values.get('smtpPort'))is int:result['smtpPort']=str(values['smtpPort'])
        if name=='notifications':
            result.update({key:value for key,value in values.get('legacyChannelSettings',{}).items()if key in KEYS})
            for key in KEYS:
                path='legacyChannelSettings.'+key
                if is_secret(key)and states.get(path)=='configured':result[key]='';result[key+'Configured']=True
        for key in ('smtpPassword','xueqiuCookie'):
            if states.get(key)=='configured':result[key+'Configured']=True
        if name=='sources':
            for person,field in (('trump','tradingSquareTrumpRefreshMinutes'),('duan','tradingSquareDuanRefreshMinutes')):
                declared=values.get('peopleRefreshIntervals',{}).get(person)
                if declared is not None:result[field]=declared
            ticker=values.get('public_ticker',{}).get('legacyPresentation')
            if ticker is not None:result['ticker']=copy.deepcopy(ticker)
        if name=='models':
            models=values.get('modelServices',[])
            for service in models:
                ident=service['id'];service['apiKey']='';service['apiKeyConfigured']=states.get('modelServices.'+ident+'.apiKey')=='configured'
                for provider,config in service.get('providerConfigs',{}).items():
                    config['apiKey']='';config['apiKeyConfigured']=states.get('modelServices.'+ident+'.providerConfigs.'+provider+'.apiKey')=='configured'
            result.update(modelServices=models,modelServicesInitialized=group['state']not in ('installation',))
            if group['state']=='unavailable':result['modelServicesError']='模型配置不可用，请核对当前实例与密钥'
            active=[s for s in models if s['id']==values.get('activeModelServiceId')]
            selected=active[0]if len(active)==1 else models[0]if len(models)==1 else None
            if selected:
                result.update(llmProvider=selected['provider'],llmApiUrl=selected['apiUrl'],llmModel=selected.get('selectedModel')or'',llmApiKey='',llmApiKeyConfigured=selected['apiKeyConfigured'])
            deep=[s for s in models if s['provider']=='deepseek']
            if len(deep)==1:result.update(deepseekApiUrl=deep[0]['apiUrl'],deepseekModel=deep[0].get('selectedModel')or'',deepseekApiKey='',deepseekApiKeyConfigured=deep[0]['apiKeyConfigured'])
    return result


async def current_channels(conn,db,who):
    from .market_worker import Bound
    from .notification_providers import Providers
    from .price_alert_runtime import targets
    from .legacy_notification_settings import CREDENTIALS
    service=Providers(Bound(conn,db.settings),targets(db.settings));result={};evidence={}
    for channel,mapping in CREDENTIALS.items():
        row=await service.current(conn,who.id,channel)
        if not row:
            latest=await service.latest(conn,who.id,channel)
            if latest:result[channel+'Enabled']=False;evidence[channel]={'state':'revoked','providerRevision':str(latest['revision']),'deliveryHealth':'not_active'}
            continue
        try:target,values=service.materialize(row)
        except Exception:
            evidence[channel]={'state':'retained_unavailable','configurationKnown':False};continue
        result[channel+'Enabled']=True
        if target.label:result[channel+'Name']=target.label
        for suffix,key in mapping.items():
            field=channel+suffix
            if is_secret(field):result[field]='';result[field+'Configured']=bool(values.get(key))
            elif key in values:result[field]=str(values[key])
        evidence[channel]={'state':'registered_owner_configuration','providerRevision':str(row['revision']),'deliveryHealth':'not_checked','recipientAutoBound':False}
    if evidence:result['notificationConfigurationSources']=evidence
    return result
