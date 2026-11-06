"""Legacy group/ticker declarations through their existing authoritative services."""
import copy
import math
import hashlib
import json
from uuid import UUID, uuid5

from fastapi import HTTPException

from .market_worker import Bound
from .private_runtime_settings import PrivateRuntimeSettings


def ticker_declaration(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get('items'), list):
        raise HTTPException(400, 'Ticker需要明确条目数组')
    if len(raw['items']) > 20:
        raise HTTPException(413, 'Ticker条目超过完整读取预算')
    items=[];seen=set()
    for item in raw['items']:
        if not isinstance(item,dict) or any(not isinstance(item.get(key),str) or not item[key].strip() for key in ('key','secid','label','market')):
            continue
        clean={key:item[key].strip() for key in ('key','secid','label','market')}
        if clean['key'] in seen:
            continue
        if any(len(value.encode('utf-8'))>500 or '\x00' in value for value in clean.values()):
            raise HTTPException(400,'Ticker条目文字无效')
        seen.add(clean['key']);items.append(clean)
    if not items:
        return None
    value=raw.get('interval')
    try:
        seconds=float(value) if value not in (None,'') else 0
    except (ValueError,TypeError,OverflowError):
        seconds=0
    rounded=math.floor(seconds+0.5) if math.isfinite(seconds) else 60 if seconds>0 else 0
    return {'items':items,'interval':min(60,max(3,rounded or 5))}


def merge_ticker(current, declaration):
    """Presentation keys cannot confer a licence or retarget an installed source."""
    current=current if isinstance(current,dict) else {}
    installed={item.get('key'):item for item in current.get('items',[]) if isinstance(item,dict)}
    previous={item.get('key'):item for item in current.get('legacyPresentation',{}).get('items',[]) if isinstance(item,dict)}
    bindings=current.get('legacyPresentationBindings',{});new_bindings={}
    items=[]
    for item in declaration['items']:
        old=installed.get(item['key'],{})
        prior=previous.get(item['key'],{})
        identity={key:old.get(key)for key in ('market','code','instrument','session','licenseId','sourceOwnerId','sourceRevision','targetFingerprint','licenseRevision')}
        identity_hash=hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        explicit=old.get('legacySecid',old.get('secid'))==item['secid']and old.get('legacyIdentityFingerprint',identity_hash)==identity_hash
        retained=prior.get('secid')==item['secid']and prior.get('market')==item['market']and bindings.get(item['key'])==identity_hash
        same=old.get('market')==item['market']and(explicit or retained)
        entry=copy.deepcopy(old) if same else {'key':item['key'],'market':item['market'],'publicDisplay':False,'missing':'explicit_public_source_identity_not_installed'}
        entry.update(key=item['key'],label=item['label'],legacySecid=item['secid'])
        if same:entry['legacyIdentityFingerprint']=identity_hash;new_bindings[item['key']]=identity_hash
        items.append(entry)
    return {**current,'items':items,'interval':declaration['interval']*1000,'legacyPresentation':copy.deepcopy(declaration),'legacyPresentationBindings':new_bindings}


async def apply_domains(conn,app,who,parent_request_id,raw,*,private_revision):
    """Caller owns the parent transaction and admin verification; children use its connection."""
    parent=UUID(str(parent_request_id));effects=[];consumed=[]
    if 'groups' in raw:
        directory=copy.copy(app.state.shared_broker_directory)
        directory.db=Bound(conn,app.state.db.settings)
        row=await directory.row(conn)
        receipt=await directory.save(who,uuid5(parent,'shared-broker-directory'),raw['groups'],revision=row['revision'])
        if receipt.get('state')!='completed':raise HTTPException(409,'原共享目录子操作已关闭或未完成，不能宣称设置整体成功')
        effects.append({'domain':'groups','receipt':receipt});consumed.append('groups')
    if 'ticker' in raw:
        consumed.append('ticker');declaration=ticker_declaration(raw['ticker'])
        if declaration is not None:
            private=PrivateRuntimeSettings(Bound(conn,app.state.db.settings))
            revision,values=await private.private_on_connection(conn)
            if revision!=private_revision:
                raise HTTPException(409,'私有配置修订已变化')
            configuration=merge_ticker(values.get('public_ticker'),declaration)
            receipt=await private.save(who,{'requestId':str(uuid5(parent,'public-ticker')),'expectedRevision':revision,'group':'sources','patch':{'public_ticker':configuration}},connection=conn)
            if receipt.get('state')!='completed':raise HTTPException(409,'原Ticker配置子操作未完成')
            private_revision=receipt['revision'];effects.append({'domain':'ticker','receipt':receipt})
    return {'effects':effects,'privateRevision':private_revision,'consumedFields':consumed}
