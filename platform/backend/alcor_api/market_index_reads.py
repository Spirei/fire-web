"""Private index presentations over the same typed quote facts as the ticker."""
from .market_indices import INDEXES
from .market_quote_reads import BatchQuotes
from .market_contract import Query
from fastapi import HTTPException

NAMES={'dji':'道琼斯指数','spx':'标普500','ndx':'纳斯达克综合指数','hsi':'恒生指数','sse':'上证指数','szse':'深证成指','n225':'日经225','ks11':'韩国KOSPI','sti':'海峡时报指数'}
MARKETS={'US':'美股','HK':'港股','CN':'A股','JP':'日股','KR':'韩股','SG':'新加坡'}


def items():
    return [{'id':key,'market':row[0],'code':row[1]} for key,row in INDEXES.items()]


async def installed(authority,who):
    # An installed template is not an activated owner source. Explicit old
    # discovery/public configurations retain their behavior until setup is saved.
    async with authority.db.connection() as conn,conn.transaction():
        rows=await (await conn.execute('SELECT revision FROM market_source_configs WHERE owner_id=%s ORDER BY revision LIMIT 1001',(who.id,))).fetchall()
        if len(rows)>1000:raise HTTPException(503,'指数来源超过核对范围')
        for row in rows:
            try:_,policy=await authority.config(conn,who.id,row['revision'])
            except HTTPException:continue
            if policy.source not in ('eastmoney','yahoo'):continue
            for item in items():
                try:authority.validate_query(policy,Query('latest',item['market'],item['code'],instrument='index'))
                except HTTPException:continue
                return True
    return False


async def read(authority,who):
    rows=items()
    result=await BatchQuotes(authority).read(who,rows,instrument='index',source_preference='auto',strict_sources=False,include_market_cap=False)
    groups={};count=0
    for item in rows:
        quote=result['quotes'].get(item['id'],{})
        if quote.get('price') is not None:count+=1
        group=groups.setdefault(item['market'],{'market':item['market'],'label':MARKETS[item['market']],'flag':'','open':None,'indices':[]})
        group['indices'].append({'name':NAMES[item['id']],'open':quote.get('open'),'latest':quote.get('price'),'changePct':quote.get('changePct'),
            'time':quote.get('time',''),'source':quote.get('source'),'session':quote.get('session'),'cached':quote.get('cached'),
            'sourceRevision':result.get('quoteStates',{}).get(item['id'],{}).get('sourceRevision'),'marketStatusKnown':False})
    return {'groups':list(groups.values()),'coverage':{'scope':'same_private_index_quote_pool','complete':count==len(rows),'observedCount':count,'providerTotal':len(rows)},'collectionOnRead':False}
