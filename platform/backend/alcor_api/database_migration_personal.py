"""Owned planning, independent ledger, card IDs/holdings and original activity import."""
import json
from decimal import Decimal
from uuid import UUID,uuid5

from psycopg.types.json import Jsonb

from .backups import BackupFailure
from .database_migration_assets import input_manifest,original_bytes,plain
from .database_migration_capture import canonical,sha
from .database_migration_jobs import guard
from .legacy_record_writes import TransactionDB


async def execute(db,task,who,plan,frozen):
    owner=plan['source_owner'];source=plan['portfolio'];schema=source['source_schema']
    selected={name:[plain(row) for row in frozen.rows(schema,name) if str(row.get('user_id'))==owner] for name in ('user_settings','activities','card_holdings','custom_cards','price_alert_rules','feed_groups','feed_preferences','feed_group_preferences','feed_posts','feed_messages')}
    source_hash=sha(canonical(selected))
    async with db.connection() as conn:
        prior=await(await conn.execute('SELECT source_sha256,result FROM database_migration_personal_imports WHERE owner_id=%s AND source_instance=%s AND source_owner=%s',(who.id,source['source_instance'],owner))).fetchone()
    if prior:
        if prior['source_sha256']!=source_hash:raise BackupFailure('已迁入的个人数据来源已变化')
        return prior['result']
    await guard(db,task,{'phase':'completion_personal','processed':0,'total':4,'unit':'domains','business_written':True,'completed_domains':['accounts','positions','orders','cash','pnl','assets']})
    async with db.connection() as conn,conn.transaction():
        from .personal_data_transfer import PersonalDataTransfer,COLUMNS
        from .simple_ledger import SimpleLedger
        from .card_preferences import CardPreferences,persist_json
        from .card_catalog_contract import custom_input,sqlite_metadata
        from .system_assets import SystemAssets
        service=PersonalDataTransfer(TransactionDB(db,conn));await service.lock(conn,who)
        data={'activities':[{k:v for k,v in row.items() if k in COLUMNS['activities']} for row in selected['activities']],
            'userSettings':[]}
        request_id=str(uuid5(task['request_id'],'personal-originals'))
        preview=await service.preview(who,{'requestId':request_id,'payload':{'format':'fire-site-backup','version':2,'data':data},'mappings':{'mode':'mapped-domain-import','sourceOwnerId':owner}})
        if not preview['confirmSupported']:raise BackupFailure('个人规划或活动记录存在未处理的差异')
        await service.submit(who,{'requestId':request_id,'previewId':preview['previewId']})
        from .fire_transfer import import_on_connection as import_fire
        async def migration_actor(connection,principal):
            from .worker import owned_row
            from .security import lock_mutation_identity
            lease=await owned_row(connection,task)
            if not lease or lease['status']!='running' or lease['kind']!='database.migration.complete' or lease['owner_id']!=principal.id or task['payload']['_session_hash']!=principal.token_hash:
                raise BackupFailure('原迁移授权已变化')
            await lock_mutation_identity(connection,principal)
        for row in selected['user_settings']:
            current=await(await conn.execute('SELECT revision FROM fire_planning_settings WHERE owner_id=%s',(who.id,))).fetchone()
            await import_fire(conn,who,str(uuid5(task['request_id'],'fire-originals')),current['revision'] if current else 0,json.loads(row.get('fire') or '{}',parse_float=Decimal),actor_guard=migration_actor)
        ledger=SimpleLedger(TransactionDB(db,conn))
        if getattr(who,'legacy_client',False) and not getattr(who,'legacy_platform',False):who.simple_session_client='legacy-web'
        for row in selected['user_settings']:
            if row.get('simple'):
                incoming=json.loads(row['simple'],parse_float=Decimal)
                current=await ledger.current(conn,who.id)
                await ledger.save(who,{'requestId':str(uuid5(task['request_id'],'simple-originals')),'expectedRevision':current['revision'],'ledger':incoming})
        _,files,_=input_manifest(db.settings,plan)
        shared_cards=0
        if 'uploads/cards/manifest.json' in files:
            from .card_catalog import CardCatalog
            from .card_catalog_contract import manifest_value
            raw,_,_=original_bytes(db.settings,'/uploads/cards/manifest.json',files)
            content=raw.decode('utf-8-sig');value=manifest_value(content,'迁移原卡面清单')
            cards=CardCatalog(TransactionDB(db,conn));current=await cards.source(conn)
            if current['id'] is None:
                await cards.import_source(who,content,'迁移原卡面清单',uuid5(task['request_id'],'card-manifest'),current['revision'],value['sha256'])
            elif current['sha256']!=value['sha256']:
                raise BackupFailure('当前卡面清单与原清单不同，未覆盖')
            shared_cards=value['cardCount']
        missing_images=[]
        for row in selected['custom_cards']:
            identifier=UUID(row['id'])
            value=custom_input({**row,'currencyScope':row.get('currency_scope') or ''})
            existing=await(await conn.execute('SELECT metadata FROM card_custom_records WHERE owner_id=%s AND id=%s',(who.id,identifier))).fetchone()
            if existing:
                from .card_preferences import restore_json
                if restore_json(existing['metadata'])!=sqlite_metadata(value):raise BackupFailure('当前自定义卡片与原卡片编号冲突')
                continue
            from urllib.parse import unquote,urlsplit
            registered=files.get(unquote(urlsplit(row['image']).path).lstrip('/'))
            version=None
            if registered:
                raw,name,_=original_bytes(db.settings,row['image'],files)
                images=SystemAssets(db)
                async with images.context(who,True,connection=conn):
                    version=await images.apply(conn,who.id,{'kind':'asset','folder':'card','code':'CARD-'+identifier.hex[:20],'name':value['name']},name,raw,source_original=True)
                    await conn.execute("UPDATE system_asset_scope SET revision=revision+1 WHERE namespace='system_public'")
            else:
                # Preserve an already missing source reference. Neither a file
                # with a similar name nor a replacement image proves its bytes.
                missing_images.append(str(identifier))
            await conn.execute('INSERT INTO card_custom_records(owner_id,id,metadata,image_path,image_version,created_at) VALUES(%s,%s,%s,%s,%s,%s)',(who.id,identifier,Jsonb(persist_json(sqlite_metadata(value))),row['image'],UUID(version['version']) if version else None,row['created_at']))
        preferences=CardPreferences(TransactionDB(db,conn))
        for row in selected['card_holdings']:
            await preferences.mutate(who,'holdings',row['card_key'],True,uuid5(task['request_id'],'holding:'+row['card_key']))
        from .database_migration_personal_history import import_owned_history
        extra=await import_owned_history(conn,who,plan,selected,task)
        result={'fire_plans':len(selected['user_settings']),'simple_ledgers':sum(bool(row.get('simple')) for row in selected['user_settings']),
                'activities':len(selected['activities']),'custom_cards':len(selected['custom_cards']),'shared_cards':shared_cards,'card_holdings':len(selected['card_holdings']),'original_card_ids_preserved':True,'source_missing_card_images':missing_images,**extra}
        from .worker import owned_row
        if not (lease:=await owned_row(conn,task)) or lease['status']!='running':raise BackupFailure('迁移已停止，个人数据未提交')
        await conn.execute('INSERT INTO database_migration_personal_imports(owner_id,source_instance,source_owner,source_sha256,task_id,result) VALUES(%s,%s,%s,%s,%s,%s)',(who.id,source['source_instance'],owner,source_hash,task['id'],Jsonb(result)))
    return result
