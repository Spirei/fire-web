"""PG-authoritative manual card records; no broker, local ledger, quote or fabricated opening is consulted."""

import hmac
import json
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .card_preferences import card_key, persist_json, restore_json
from .card_wallet_contract import command, details_patch, hashed, replay
from .cash_ledger import CashLedger, add
from .cash_ledger import normalize as cash_command
from .connections import Vault
from .security import digest, lock_mutation_identity


def wire(value):
    if isinstance(value,Decimal):
        return str(value)
    if isinstance(value,(datetime,UUID)):
        return value.isoformat() if isinstance(value,datetime) else str(value)
    if isinstance(value,list):
        return [wire(item) for item in value]
    if isinstance(value,dict):
        return {key:wire(item) for key,item in value.items()}
    return value


def public_plan(value):
    return wire({key:item for key,item in value.items() if not key.startswith('_')})


class CardWallet:
    def __init__(self, db):
        self.db=db
        self.vault=Vault(db.settings.connection_secret_dir)

    @asynccontextmanager
    async def context(self,who,*,read_only=False):
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
            await lock_mutation_identity(conn,who,require_admin=False)
            if read_only:
                head=await(await conn.execute('SELECT revision FROM card_wallet_collections WHERE owner_id=%s',(who.id,))).fetchone()
                revision=head['revision'] if head else 0
            else:
                await conn.execute('INSERT INTO card_wallet_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING',(who.id,))
                revision=(await(await conn.execute('SELECT revision FROM card_wallet_collections WHERE owner_id=%s FOR UPDATE',(who.id,))).fetchone())['revision']
            yield conn,revision

    async def preference_revision(self,conn,owner):
        row=await(await conn.execute('SELECT revision FROM card_preference_collections WHERE owner_id=%s',(owner,))).fetchone()
        return row['revision'] if row else 0

    async def prior(self,conn,who,identifier,fingerprint=None):
        row=await(await conn.execute('SELECT * FROM card_wallet_operations WHERE owner_id=%s AND request_id=%s',(who.id,identifier))).fetchone()
        if row:
            if row['kind']=='closed':
                raise HTTPException(409,'原卡包请求已关闭，请查询原编号')
            if fingerprint is not None and row['fingerprint']!=fingerprint:
                raise HTTPException(409,'原UUID已用于其他卡包操作')
            return restore_json(row['result'])
        return None

    def secret(self,row):
        if not row or not row['secret_ciphertext']:
            return {}
        if not (self.vault.directory / 'connections.key').is_file():
            raise HTTPException(503,'卡背信息解密密钥不可用')
        raw=self.vault.decrypt(row['secret_ciphertext'],'card-wallet:'+row['owner_id']+':'+row['card_key'],row['crypto_instance'])
        try:
            value=json.loads(raw)
            if not isinstance(value,dict) or set(value)-{'number','expiry','cvv'} or any(not isinstance(item,str) for item in value.values()):
                raise ValueError()
            return value
        except (ValueError,TypeError):
            raise HTTPException(503,'已保存卡背信息无法核对') from None

    async def details(self,conn,owner,key=None):
        rows=await(await conn.execute('SELECT * FROM card_wallet_details WHERE owner_id=%s'+(' AND card_key=%s' if key is not None else '')+' ORDER BY card_key',(owner,key) if key is not None else (owner,))).fetchall()
        result={}
        for row in rows:
            value=restore_json(row['metadata'])
            try:
                private=self.secret(row)
                secret_state='available'
            except HTTPException as exc:
                if exc.status_code!=503:
                    raise
                private={};secret_state='unavailable'
            result[row['card_key']]={**value,'cardKey':row['card_key'],'numberLast4':private.get('number','')[-4:] if secret_state=='available' and private.get('number') else None,
                'numberInitialized':'number' in row['initialized_fields'],'expiryInitialized':'expiry' in row['initialized_fields'],
                'cvvInitialized':'cvv' in row['initialized_fields'],'secretState':secret_state,
                'initializedFields':row['initialized_fields'],'revision':row['revision'],'updatedAt':row['updated_at'].isoformat()}
        return result

    async def snapshot(self,who,key=None):
        key=card_key(key) if key is not None else None
        async with self.context(who,read_only=True) as (conn,revision):
            return await self.snapshot_on_connection(conn,who,key,revision)

    async def snapshot_on_connection(self,conn,who,key,revision):
        rows=await(await conn.execute('SELECT * FROM card_wallet_accounts WHERE owner_id=%s'+(' AND card_key=%s' if key is not None else '')+' ORDER BY updated_at DESC,card_key',(who.id,key) if key is not None else (who.id,))).fetchall()
        return {'revision':revision,'source':'platform-manual-card','historicalCoverageKnown':False,
            'details':await self.details(conn,who.id,key),
            'accounts':[{'cardKey':row['card_key'],'accountKind':row.get('account_kind'),'amount':wire(row['amount']),'currency':row['currency'],
                'amountKnown':row['amount'] is not None,'note':row['note'],'opening':None if row['opening_at'] is None else {'amount':wire(row['opening_amount']),'occurredAt':row['opening_at'].isoformat()},
                'updatedAt':row['updated_at'].isoformat()} for row in rows]}

    async def legacy_snapshot(self,who,key):
        key=card_key(key) if key is not None else None
        async with self.context(who,read_only=True) as (conn,revision):
            value=await self.snapshot_on_connection(conn,who,key,revision)
            if key is None:
                return {'details':value['details'],'secretFields':'masked','revision':revision}
            history=await self.history_on_connection(conn,who,key,revision,limit=5000)
            if history['nextCursor'] is not None:
                raise HTTPException(409,'完整卡包历史超出5000条预算，请使用带修订的历史分页入口')
            entries=[{**row,'delta':float(row['delta']) if row['delta'] is not None else None,'balance':float(row['balance']) if row['balance'] is not None else None} for row in history['items']]
            return {'cardKey':key,'details':value['details'].get(key),'entries':entries,
                'secretFields':'masked','revision':revision,'historicalCoverageKnown':False}

    async def plan(self,conn,who,data):
        now=(await(await conn.execute('SELECT clock_timestamp() AS now')).fetchone())['now']
        when=datetime.fromisoformat(data['occurredAt'])
        if when>now:
            raise HTTPException(422,'金额记录不能使用未来时间')
        account=await(await conn.execute('SELECT * FROM card_wallet_accounts WHERE owner_id=%s AND card_key=%s',(who.id,data['cardKey']))).fetchone()
        entries=await(await conn.execute('SELECT * FROM card_wallet_entries WHERE owner_id=%s AND card_key=%s AND deleted_at IS NULL ORDER BY occurred_at,order_id LIMIT 5001',(who.id,data['cardKey']))).fetchall()
        if len(entries)>5000:
            raise HTTPException(409,'单次历史核对超过预算，请先安排分段核对')
        before=account['amount'] if account else None
        currency=account['currency'] if account else None
        opening=account['opening_amount'] if account else None
        opening_at=account['opening_at'] if account else None
        basis=account['basis_id'] if account else None
        if entries:
            if not account or any(row['currency']!=currency or row['basis_id']!=basis for row in entries):
                raise HTTPException(409,'卡包历史来源或币种不一致，请先核对')
            registered,_=replay(entries,opening)
            if registered!=before:
                raise HTTPException(409,'卡包历史与登记金额不一致，请先核对')
        operation=data['operation'];projected=[];new_entry=None;removed=None
        if operation in ('set_amount','clear_amount'):
            if entries:
                raise HTTPException(409,'已有余额流水，请使用余额调整或先核对原流水')
            if opening_at and when<opening_at:
                raise HTTPException(409,'核对时间早于现有金额核对点')
            after=Decimal(data['amount']) if operation=='set_amount' else None
            currency_after=data['currency'] if operation=='set_amount' else currency
            opening_after=after;opening_at_after=when if after is not None else None;basis_after=UUID(data['requestId'])
        else:
            if operation=='delete_entry':
                removed=next((row for row in entries if str(row['id'])==data['entryId']),None)
                if not removed:
                    raise HTTPException(404,'流水不存在')
                remaining=[row for row in entries if row['id']!=removed['id']]
            else:
                if data['currency'] is None:
                    raise HTTPException(409,'请先核对金额币种')
                if currency is not None and currency!=data['currency']:
                    raise HTTPException(409,'历史币种不可混合或按当前币种倒填')
                if before is not None and currency is None:
                    raise HTTPException(409,'既有金额的币种未知，请先明确核对')
                currency=data['currency']
                if opening_at is None:
                    if operation!='adjust':
                        raise HTTPException(409,'期初余额未知，请先核对金额或登记绝对余额调整')
                    opening_at=when;basis=UUID(data['requestId'])
                if when<opening_at:
                    raise HTTPException(409,'记录时间早于已核对的期初，不能倒填未知历史')
                new_entry={'id':UUID(data['requestId']),'kind':operation,'original_amount':Decimal(data['amount']),
                    'target_amount':Decimal(data['amount']) if operation=='adjust' else None,
                    'occurred_at':when,'order_id':max([row['order_id'] for row in entries],default=0)+1,
                    'note':data['note'],'currency':currency,'basis_id':basis}
                remaining=[*entries,new_entry]
            after,projected=replay(remaining,opening)
            currency_after=currency;opening_after=opening;opening_at_after=opening_at;basis_after=basis
            if after is None and not remaining and opening is None:
                opening_at_after=None;basis_after=None
        negative=after is not None and after<0 or any(row['balance']<0 for row in projected)
        delta=add(after,before.copy_negate()) if before is not None and after is not None and currency_after==(account['currency'] if account else None) else None
        result={'operation':operation,'cardKey':data['cardKey'],'source':'platform-manual-card',
                'before':{'amount':wire(before),'currency':account['currency'] if account else None},
                'after':{'amount':wire(after),'currency':currency_after},'delta':wire(delta),
                'needsNegativeConfirmation':bool(negative),'brokerLinked':False,'historicalCoverageKnown':False,
                'recordedEntry':None if new_entry is None else {'id':str(new_entry['id']),'kind':new_entry['kind'],'amount':wire(new_entry['target_amount'] if new_entry['kind']=='adjust' else new_entry['original_amount']),'currency':new_entry['currency'],'occurredAt':new_entry['occurred_at'].isoformat()},
                'removedEntry':None if removed is None else {'id':str(removed['id']),'kind':removed['kind'],'amount':wire(removed['target_amount'] if removed['kind']=='adjust' else removed['original_amount']),'currency':removed['currency'],'occurredAt':removed['occurred_at'].isoformat()},
                'historyEffects':[{'id':str(row['id']),'kind':row['kind'],'delta':wire(row['delta']),'balance':wire(row['balance']),'currency':row['currency'],'occurredAt':row['occurred_at'].isoformat()} for row in projected],
                '_account':account,'_after':after,'_currency':currency_after,'_opening':opening_after,'_opening_at':opening_at_after,'_basis':basis_after,
                '_new':new_entry,'_removed':removed,'_projected':projected}
        original_link=None
        if removed:
            original_link=await(await conn.execute('SELECT * FROM card_wallet_cash_links WHERE owner_id=%s AND card_entry_id=%s AND reversal_of IS NULL',(who.id,removed['id']))).fetchone()
        if data.get('fundAccount')=='broker' or original_link:
            ledger=CashLedger(self.db);cash_revision=await ledger.lock(conn,who)
            if original_link:
                if await(await conn.execute('SELECT 1 FROM card_wallet_cash_links WHERE owner_id=%s AND reversal_of=%s',(who.id,original_link['request_id']))).fetchone():raise HTTPException(409,'原联动已登记反向凭证')
                account_id=original_link['account_id'];account_kind=original_link['account_kind'];linked_currency=original_link['currency'];cash_delta=original_link['cash_delta'].copy_negate()
            else:
                if data['cashRevision']!=cash_revision:raise HTTPException(409,'现金版本已变化')
                account_id=data['accountId'];account_kind=data['accountKind'];linked_currency=currency_after
                if account and account.get('account_kind') is not None and account['account_kind']!=account_kind:raise HTTPException(409,'同一卡包记录不能混用真实与模拟资金')
                cash_delta=Decimal(data['amount']).copy_negate() if operation=='deposit' else Decimal(data['amount'])
            if not linked_currency or linked_currency!=currency_after:raise HTTPException(409,'卡与券商的原币必须明确且一致')
            from .broker_accounts import broker_account
            broker=await broker_account(conn,who.id,account_id)
            if broker['account_kind']!=account_kind or not original_link and broker['revision']!=data['accountRevision']:raise HTTPException(409,'券商账户版本或账本身份已变化')
            child=str(uuid5(UUID(data['requestId']),'card-wallet-cash-reversal' if original_link else 'card-wallet-cash'))
            cash_action='external_deposit' if (original_link and removed['kind']=='deposit') or (not original_link and operation=='withdraw') else 'external_withdrawal'
            cash_data=cash_command({'requestId':child,'accountId':account_id,'accountKind':account_kind,'currency':linked_currency,
                'action':cash_action,'amount':str(cash_delta.copy_abs()),'occurredAt':data['occurredAt'],'note':data['note']})
            _,actual_delta,_,cash_before,_=await ledger.plan(conn,who,cash_data)
            if actual_delta!=cash_delta:raise HTTPException(409,'卡与现金两端差额不一致')
            cash_complete=await ledger.account_complete(conn,who,cash_data)
            result['brokerLinked']=True
            result['brokerTransfer']={'accountId':account_id,'accountKind':account_kind,'currency':linked_currency,'accountRevision':broker['revision'],'cashRevision':cash_revision,
                'cardDelta':str(cash_delta.copy_negate()),'cashDelta':str(cash_delta),'cashBefore':str(cash_before) if cash_complete else None,'cashAfter':str(add(cash_before,cash_delta)) if cash_complete else None,'cashComplete':cash_complete,
                'registeredCashBefore':str(cash_before),'registeredCashAfter':str(add(cash_before,cash_delta)),
                'requestId':child,'reversalOf':str(original_link['request_id']) if original_link else None,'originalCashEntryId':str(original_link['cash_entry_id']) if original_link else None}
            result['_cash_data']=cash_data;result['_cash_link']=original_link
        return result

    async def preview(self,who,raw):
        data=command(raw)
        async with self.context(who) as (conn,revision):
            if await self.prior(conn,who,data['requestId']):
                raise HTTPException(409,'原请求已有回执，请查询原UUID')
            if revision!=data['expectedRevision']:
                raise HTTPException(409,'卡包记录已变化，请重新读取后预览')
            from .asset_request_domains import require_domain
            await require_domain(conn,who.id,data['requestId'],'card_wallet')
            plan=await self.plan(conn,who,data)
            preference=await self.preference_revision(conn,who.id)
            token=secrets.token_urlsafe(32)
            proof=await(await conn.execute("INSERT INTO card_wallet_previews(token_hash,owner_id,session_hash,payload_hash,revision,preference_revision,plan_hash,expires_at) VALUES(%s,%s,%s,%s,%s,%s,%s,clock_timestamp()+interval '10 minutes') RETURNING expires_at",(digest(token),who.id,who.token_hash,hashed(data),revision,preference,hashed(public_plan(plan))))).fetchone()
            return {'requestId':data['requestId'],'preview':token,'expiresAt':proof['expires_at'].isoformat(),'revision':revision,'preferenceRevision':preference,'effects':public_plan(plan)}

    async def submit(self,who,raw,proof,*,project=None):
        data=command(raw);fingerprint=hashed(data)
        if not isinstance(proof,str) or not 1<=len(proof)<=128:
            raise HTTPException(422,'预览凭证无效')
        async with self.context(who) as (conn,revision):
            if previous:=await self.prior(conn,who,data['requestId'],fingerprint):
                return previous
            from .asset_request_domains import require_domain
            await require_domain(conn,who.id,data['requestId'],'card_wallet')
            preview=await(await conn.execute('SELECT * FROM card_wallet_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s AND expires_at>clock_timestamp() FOR UPDATE',(digest(proof),who.id,who.token_hash))).fetchone()
            preference=await self.preference_revision(conn,who.id)
            if not preview or preview['payload_hash']!=fingerprint or preview['revision']!=revision or data['expectedRevision']!=revision or preview['preference_revision']!=preference:
                raise HTTPException(409,'预览已失效，请重新读取并预览')
            plan=await self.plan(conn,who,data)
            if preview['plan_hash']!=hashed(public_plan(plan)):
                raise HTTPException(409,'卡包记录已变化，请重新预览')
            if plan['needsNegativeConfirmation'] and not data['allowNegativeBalance']:
                raise HTTPException(409,'请明确核对负余额后重新预览')
            await conn.execute('INSERT INTO card_wallet_accounts(owner_id,card_key) VALUES(%s,%s) ON CONFLICT DO NOTHING',(who.id,data['cardKey']))
            if plan['_removed']:
                await conn.execute('UPDATE card_wallet_entries SET deleted_at=clock_timestamp() WHERE owner_id=%s AND id=%s',(who.id,plan['_removed']['id']))
            if plan['_new']:
                row=plan['_new']
                await conn.execute('INSERT INTO card_wallet_entries(owner_id,id,card_key,basis_id,kind,original_amount,target_amount,currency,note,occurred_at,projection_revision) VALUES('+','.join(['%s']*11)+')',(who.id,row['id'],data['cardKey'],row['basis_id'],row['kind'],row['original_amount'],row['target_amount'],row['currency'],row['note'],row['occurred_at'],revision+1))
            for row in plan['_projected']:
                await conn.execute('UPDATE card_wallet_entries SET delta=%s,balance=%s,projection_revision=%s WHERE owner_id=%s AND id=%s',(row['delta'],row['balance'],revision+1,who.id,row['id']))
            if data['operation'] in ('set_amount','clear_amount'):
                await conn.execute('INSERT INTO card_wallet_checkpoints(owner_id,id,card_key,kind,amount,currency,note,occurred_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,data['requestId'],data['cardKey'],data['operation'],plan['_after'],plan['_currency'],data['note'],data['occurredAt']))
            note=data['note'] if data['operation']=='set_amount' else '' if data['operation']=='clear_amount' else plan['_account']['note'] if plan['_account'] else ''
            await conn.execute('UPDATE card_wallet_accounts SET amount=%s,currency=%s,opening_amount=%s,opening_at=%s,basis_id=%s,note=%s,updated_at=clock_timestamp() WHERE owner_id=%s AND card_key=%s',(plan['_after'],plan['_currency'],plan['_opening'],plan['_opening_at'],plan['_basis'],note,who.id,data['cardKey']))
            if data['operation'] in ('set_amount','deposit','withdraw','adjust'):
                await conn.execute('INSERT INTO card_preference_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING',(who.id,))
                existing=await(await conn.execute('SELECT held FROM card_preference_holdings WHERE owner_id=%s AND card_key=%s',(who.id,data['cardKey']))).fetchone()
                if not existing or not existing['held']:
                    await conn.execute('INSERT INTO card_preference_holdings(owner_id,card_key,held) VALUES(%s,%s,true) ON CONFLICT(owner_id,card_key) DO UPDATE SET held=true,created_at=clock_timestamp()',(who.id,data['cardKey']))
                    await conn.execute('UPDATE card_preference_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
            if plan.get('_cash_data'):
                ledger=CashLedger(self.db)
                cash_proof=await ledger.preview(who,plan['_cash_data'],connection=conn)
                original=plan.get('_cash_link')
                cash_result=await ledger._submit_ledger(who,plan['_cash_data'],cash_proof['preview'],connection=conn,reversal_entry_id=original['cash_entry_id'] if original else None)
                transfer=plan['brokerTransfer']
                await conn.execute('INSERT INTO card_wallet_cash_links(owner_id,request_id,card_entry_id,cash_entry_id,account_id,account_kind,currency,card_delta,cash_delta,reversal_of) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                    (who.id,data['requestId'],plan['_removed']['id'] if original else plan['_new']['id'],cash_result['entryId'],transfer['accountId'],transfer['accountKind'],transfer['currency'],Decimal(transfer['cardDelta']),Decimal(transfer['cashDelta']),original['request_id'] if original else None))
                await conn.execute('UPDATE card_wallet_accounts SET account_kind=%s WHERE owner_id=%s AND card_key=%s',(transfer['accountKind'],who.id,data['cardKey']))
                plan['brokerTransfer']['cashEntryId']=cash_result['entryId']
            result={'requestId':data['requestId'],'state':'completed','revision':revision+1,'effects':public_plan(plan)}
            if project is not None:result=await project(conn,result)
            await conn.execute('INSERT INTO card_wallet_operations(owner_id,request_id,kind,fingerprint,result) VALUES(%s,%s,\'financial\',%s,%s)',(who.id,data['requestId'],fingerprint,Jsonb(result)))
            await conn.execute('UPDATE card_wallet_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
            await conn.execute("INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'cards.wallet.financial_recorded',%s)",(who.id,data['requestId']))
            return result

    async def save_details(self,who,key,raw,identifier,expected,*,legacy=False):
        key=card_key(key);patch=details_patch(raw,legacy=legacy)
        async with self.context(who) as (conn,revision):
            current=await(await conn.execute('SELECT * FROM card_wallet_details WHERE owner_id=%s AND card_key=%s',(who.id,key))).fetchone()
            private=self.secret(current)
            if not (self.vault.directory / 'connections.key').is_file() and await(await conn.execute('SELECT 1 FROM card_wallet_details WHERE secret_ciphertext IS NOT NULL LIMIT 1')).fetchone():
                raise HTTPException(503,'卡背信息解密密钥不可用')
            fingerprint=hmac.new(self.vault.key(),json.dumps([key,patch,expected],ensure_ascii=True,sort_keys=True,separators=(',',':')).encode(),'sha256').hexdigest()
            if previous:=await self.prior(conn,who,identifier,fingerprint):
                return previous
            if expected is not None and (type(expected) is not int or expected!=revision):
                raise HTTPException(409,'卡背信息已变化，请重新读取')
            metadata=restore_json(current['metadata']) if current else {}
            if 'currency' in patch:
                account=await(await conn.execute('SELECT amount,currency FROM card_wallet_accounts WHERE owner_id=%s AND card_key=%s',(who.id,key))).fetchone()
                if account and account['amount'] is not None and patch['currency']!=(account['currency'] or ''):
                    raise HTTPException(409,'金额币种变更须核对完整金额并预览，不能通过卡背信息改账')
            metadata.update({key:value for key,value in patch.items() if key not in ('number','expiry','cvv')})
            private.update({key:value for key,value in patch.items() if key in ('number','expiry','cvv')})
            cipher=self.vault.encrypt(json.dumps(private,ensure_ascii=True),'card-wallet:'+who.id+':'+key,self.db.settings.instance_id) if private else None
            initialized=sorted(set(current['initialized_fields'] if current else [])|set(patch))
            await conn.execute('INSERT INTO card_wallet_details(owner_id,card_key,metadata,secret_ciphertext,crypto_instance,initialized_fields,revision) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,card_key) DO UPDATE SET metadata=excluded.metadata,secret_ciphertext=excluded.secret_ciphertext,crypto_instance=excluded.crypto_instance,initialized_fields=excluded.initialized_fields,revision=excluded.revision,updated_at=clock_timestamp()',(who.id,key,Jsonb(persist_json(metadata)),cipher,self.db.settings.instance_id,initialized,revision+1))
            result={'requestId':str(identifier),'state':'completed','revision':revision+1,'cardKey':key,'initializedFields':initialized,'secretValuesIncluded':False}
            if legacy:
                result['legacySnapshot']={'details':await self.details(conn,who.id),'secretFields':'masked'}
            await conn.execute('INSERT INTO card_wallet_operations(owner_id,request_id,kind,fingerprint,result) VALUES(%s,%s,\'details\',%s,%s)',(who.id,identifier,fingerprint,Jsonb(result)))
            await conn.execute('UPDATE card_wallet_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
            await conn.execute("INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'cards.wallet.details_updated',%s)",(who.id,identifier))
            return result

    async def reveal(self,who,key,verify):
        key=card_key(key)
        async with self.context(who) as (conn,_):
            await verify(conn)
            row=await(await conn.execute('SELECT * FROM card_wallet_details WHERE owner_id=%s AND card_key=%s',(who.id,key))).fetchone()
            if not row:
                raise HTTPException(404,'卡背信息尚未登记')
            value=self.secret(row)
            await conn.execute("INSERT INTO audit_events(actor_id,action) VALUES(%s,'cards.wallet.details_revealed')",(who.id,))
            return {'cardKey':key,'number':value.get('number',''),'expiry':value.get('expiry',''),'cvv':value.get('cvv',''),'initializedFields':row['initialized_fields']}

    async def history(self,who,key,*,limit=25,after=None,revision=None,include_deleted=False):
        key=card_key(key)
        if type(limit) is not int or not 1<=limit<=100:
            raise HTTPException(422,'历史读取上限无效')
        async with self.context(who,read_only=True) as (conn,current):
            return await self.history_on_connection(conn,who,key,current,limit=limit,after=after,revision=revision,include_deleted=include_deleted)

    async def history_on_connection(self,conn,who,key,current,*,limit,after=None,revision=None,include_deleted=False):
        if revision is not None and revision!=current:
            raise HTTPException(409,'卡包历史已变化，请重新读取第一页')
        args=[who.id,key];condition='' if include_deleted else ' AND deleted_at IS NULL'
        if after is not None:
            if revision is None:
                raise HTTPException(409,'续读历史必须核对原修订')
            cursor=await(await conn.execute('SELECT occurred_at,order_id FROM card_wallet_entries WHERE owner_id=%s AND card_key=%s AND id=%s',(who.id,key,after))).fetchone()
            if not cursor:
                raise HTTPException(404,'历史分页标记不存在')
            condition+=' AND (occurred_at,order_id)<(%s,%s)';args.extend([cursor['occurred_at'],cursor['order_id']])
        args.append(limit+1)
        rows=await(await conn.execute('SELECT e.*,(EXISTS(SELECT 1 FROM card_wallet_cash_links l WHERE l.owner_id=e.owner_id AND l.card_entry_id=e.id AND l.reversal_of IS NULL)) AS broker_linked FROM card_wallet_entries e WHERE owner_id=%s AND card_key=%s'+condition+' ORDER BY occurred_at DESC,order_id DESC LIMIT %s',tuple(args))).fetchall()
        return {'cardKey':key,'revision':current,'historicalCoverageKnown':False,'source':'platform-manual-card','items':[{'id':str(row['id']),'cardKey':row['card_key'],'kind':row['kind'],'delta':wire(row['delta']),'balance':wire(row['balance']),'currency':row['currency'],'note':row['note'],'occurredAt':row['occurred_at'].isoformat(),'brokerLinked':row['broker_linked'],'cancelled':row['deleted_at'] is not None,'projectionRevision':row['projection_revision']} for row in rows[:limit]],'nextCursor':str(rows[limit-1]['id']) if len(rows)>limit else None}

    async def receipt(self,who,identifier):
        async with self.context(who,read_only=True) as (conn,_):
            row=await(await conn.execute('SELECT result FROM card_wallet_operations WHERE owner_id=%s AND request_id=%s',(who.id,identifier))).fetchone()
            if not row:
                raise HTTPException(404,'原卡包回执不存在')
            return restore_json(row['result'])

    async def close(self,who,identifier):
        async with self.context(who) as (conn,_):
            row=await(await conn.execute('SELECT result FROM card_wallet_operations WHERE owner_id=%s AND request_id=%s',(who.id,identifier))).fetchone()
            if row:
                return restore_json(row['result'])
            from .asset_request_domains import require_domain
            await require_domain(conn,who.id,identifier,'card_wallet')
            result={'requestId':str(identifier),'state':'closed','executed':False}
            await conn.execute('INSERT INTO card_wallet_operations(owner_id,request_id,kind,fingerprint,result) VALUES(%s,%s,\'closed\',%s,%s)',(who.id,identifier,hashed(result),Jsonb(result)))
            return result


async def purge_wallet_private(conn,owner):
    installed=(await(await conn.execute("SELECT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name='0084_card_wallet_balances.sql') installed")).fetchone())['installed']
    for table in ('card_wallet_details','card_wallet_previews','card_wallet_operations'):
        if not installed:
            row=await(await conn.execute('SELECT to_regclass(%s) relation',('public.'+table,))).fetchone()
            if row['relation'] is None:
                continue
            raise HTTPException(503,'卡包数据结构尚未完整核对')
        # Financial receipts, declared checkpoints and event tombstones remain with the retired owner.
        await conn.execute('DELETE FROM '+table+' WHERE owner_id=%s'+(" AND kind='details'" if table=='card_wallet_operations' else ''),(owner,))
