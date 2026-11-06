"""Public ticker over separately licensed retained facts; no owner market access."""
from dataclasses import asdict
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .market_contract import Query, digest


async def read_ticker(db,authority,quotes):
    from .public_site import sample_points
    config=getattr(db.settings,'public_ticker',{})
    if not isinstance(config,dict):raise HTTPException(503,'公开Ticker配置无效')
    presentation=config.get('legacyPresentation',{})
    if not isinstance(presentation,dict):presentation={}
    configured=config.get('items',[])
    if not configured and isinstance(presentation.get('items'),list):configured=[{**item,'publicDisplay':False}for item in presentation['items'] if isinstance(item,dict)]
    interval=config.get('interval',presentation.get('interval',3)*1000 if type(presentation.get('interval',3)) in (int,float) else 3000)
    if not isinstance(configured,list) or len(configured)>20 or type(interval) is not int or not 1000<=interval<=300000:raise HTTPException(503,'公开Ticker配置或间隔无效')
    keys=[entry.get('key')for entry in configured if isinstance(entry,dict)]
    if len(keys)!=len(configured) or any(not isinstance(key,str) or not 1<=len(key)<=80 for key in keys) or len(set(keys))!=len(keys):raise HTTPException(503,'公开Ticker标识无效或重复')
    output=[];missing=[];bindings=[]
    for entry in configured:
        key=entry['key']
        try:
            if (entry.get('publicDisplay') is not True or not isinstance(entry.get('label'),str) or not 1<=len(entry['label'])<=100
                    or str(entry.get('instanceId',config.get('instanceId')))!=str(db.settings.instance_id)):raise ValueError('public_license_required_not_owner_source')
            # Historical owner/source metadata may remain in a migrated declaration;
            # only this independent public license ever authorizes a read.
            license_id=UUID(entry['licenseId'])
            query=Query('latest',entry['market'],entry['code'],instrument=entry.get('instrument','index'),session=entry.get('session','REGULAR')).validate()
            async with db.connection()as conn,conn.transaction():
                _,policy=await authority.current(conn,license_id,'display',query)
                rows=await(await conn.execute('''SELECT f.id,f.page_id,f.source_time,f.contents,p.raw_sha256 FROM public_market_facts f
                    JOIN public_market_pages p ON p.id=f.page_id WHERE f.license_id=%s AND f.query=%s ORDER BY f.source_time DESC,f.id DESC LIMIT 65''',(license_id,Jsonb(asdict(query))))).fetchall()
            if not rows:raise ValueError('public_observation_unavailable')
            if any(row['source_time']==rows[0]['source_time'] and digest(row['contents'])!=digest(rows[0]['contents'])for row in rows[1:]):raise ValueError('public_observation_ambiguous')
            selected=[];seen=set()
            for row in rows[:64]:
                if row['source_time'] in seen:continue
                seen.add(row['source_time']);selected.append(row)
            items=[{'id':str(row['id']),'market':query.market,'code':query.code}for row in selected]
            snapshot={str(row['id']):{'licenseId':str(license_id),'factId':str(row['id']),'pageId':str(row['page_id']),'rawSha256':row['raw_sha256']}for row in selected}
            observed=await quotes.read(items,session=query.session,include_market_cap=False,snapshot=snapshot)
            latest=str(rows[0]['id']);quote=observed['quotes'].get(latest);state=observed['quoteStates'].get(latest,{})
            if quote is None:raise ValueError('public_original_unverified')
            price=state.get('priceExact');exact=quote.get('dayStatsExact') or {}
            points=[];times=[]
            for row in reversed(selected):
                identity=str(row['id']);point=observed['quoteStates'].get(identity,{})
                if identity not in observed['quotes'] or point.get('priceExact') is None:continue
                points.append(point['priceExact']);times.append(point['sourceTime'])
            if len(points)<len(selected):missing.append({'key':key,'reason':'historical_public_observations_unverified'})
            sampled=sample_points(points)
            def legacy(value):return float(Decimal(value)) if value is not None else None
            item={'key':key,'label':entry['label'],'market':query.market,'price':legacy(price),'change':legacy(exact.get('change')),'changePct':legacy(exact.get('changePct')),
                  'priceExact':price,'changeExact':exact.get('change'),'changePctExact':exact.get('changePct'),'points':[legacy(v)for v in sampled],'pointsExact':sampled,
                  'observedAt':state.get('sourceTime'),'cached':quote.get('cached'),'displayStale':quote.get('displayStale'),'quoteState':state.get('state'),
                  'session':quote.get('session',query.session),'source':policy.source,'licenseRevision':policy.license_revision,
                  'trendBasis':{'kind':'retained_latest_observations','observedPoints':len(points),'firstAt':times[0]if times else None,'lastAt':times[-1]if times else None,
                                'calendarComplete':False,'retainedWindowLimited':len(rows)>64,'unverifiedPoints':len(selected)-len(points)},
                  'numericTransport':'legacy_numbers_with_source_exact_fields'}
            output.append(item);bindings.append((key,license_id,query,policy.fingerprint))
        except (HTTPException,ValueError,TypeError,KeyError,ArithmeticError):missing.append({'key':key,'reason':'current_public_license_or_verified_observation_unavailable'})
    # Final current permissions, serialized with revoke; do not publish an item
    # merely because an earlier entry was valid before other awaited reads.
    permitted=set()
    async with db.connection()as conn,conn.transaction():
        for key,license_id,query,fingerprint in sorted(bindings,key=lambda item:str(item[1])):
            try:
                _,policy=await authority.current(conn,license_id,'display',query)
                if policy.fingerprint!=fingerprint:raise ValueError('public_license_changed')
                permitted.add(key)
            except (HTTPException,ValueError):missing.append({'key':key,'reason':'public_display_permission_changed'})
    output=[item for item in output if item['key'] in permitted]
    observed_keys={item['key']for item in output}
    for item in configured:
        if item['key'] in observed_keys:continue
        output.append({'key':item['key'],'label':item.get('label') if isinstance(item.get('label'),str) else item['key'],'market':item.get('market') if isinstance(item.get('market'),str) else None,
            'price':None,'change':None,'changePct':None,'priceExact':None,'changeExact':None,'changePctExact':None,'points':[],'pointsExact':[],
            'observedAt':None,'cached':None,'displayStale':None,'quoteState':'unavailable','session':None,'source':None,'licenseRevision':None,
            'trendBasis':{'kind':'unavailable','observedPoints':0,'firstAt':None,'lastAt':None,'calendarComplete':False}})
    order={entry['key']:i for i,entry in enumerate(configured)}
    output.sort(key=lambda item:order[item['key']])
    return {'items':output,'interval':interval/1000,'intervalMs':interval,'pollSec':60,'crossCheck':[],'crossCheckState':'not_observed',
            'state':'unavailable'if not observed_keys else'partial'if missing else'observed','missing':missing,'collectionOnRead':False,
            'sourceCoverage':'independent_public_market_licenses_verified_retained_originals','privateOwnerMarketDataUsed':False}
