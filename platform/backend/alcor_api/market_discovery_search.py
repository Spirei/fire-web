"""Original public aliases over the single shared catalog, with no fabricated prices."""

import json
import re
from pathlib import Path

from .asset_lookup_catalog import AssetCatalog
from .card_preferences import JS_WHITESPACE
from .legacy_pinyin_match import matches
from .market_discovery_protocol import stock_symbol

ROOT=Path(__file__).parent/'data'
CRYPTO=json.loads((ROOT/'discovery-mainstream-crypto.json').read_text())
RELATED=json.loads((ROOT/'discovery-related-etfs.json').read_text())


def normalized(value):return re.sub(r'[\s_-]+',' ',value.strip(JS_WHITESPACE).lower())


def crypto(text):
    value=normalized(text)
    if not value:return []
    exact=any(normalized(alias)==value for item in CRYPTO for alias in item['aliases'])
    return [{'symbol':'CRYPTO:'+item['id'],'code':item['code'],'name':item['name'],'market':'ASSET','price':None,'changePct':None,'type':'crypto'}
        for item in CRYPTO if any(normalized(alias)==value if exact else normalized(alias).startswith(value) for alias in item['aliases'])]


def special(text):
    value=re.sub(r'[\s_-]+','',text.strip(JS_WHITESPACE).lower())
    if value=='ram' or 'dram' in value and re.search(r'2x|2倍|两倍|二倍|2做多|long',value):
        return [{'symbol':'usRAM','code':'RAM','name':'DRAM 2 倍做多 ETF','market':'US','price':None,'changePct':None}]
    return []


async def local(conn,text,db):
    # Public metadata shares its existing catalog lock/authority. No copied stock
    # directory and no scan of image files or users' private portfolio names.
    async with AssetCatalog(db).context(connection=conn):
        rows=await (await conn.execute("SELECT e.* FROM asset_catalog_entries e WHERE type='stock' AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=e.id AND t.restored_at IS NULL) ORDER BY created_at,id LIMIT 20001")).fetchall()
    if len(rows)>20000:return [],{'state':'catalog_budget_exceeded','complete':False}
    pattern=re.compile('.*'+''.join('.*' if char=='%' else '.' if char=='_' else re.escape(char) for char in text.lower())+'.*',re.DOTALL)
    found=[row for row in rows if pattern.fullmatch(row['code'].lower()) or pattern.fullmatch(row['name'].lower()) or matches(row['name'],text)]
    # Unavailable market capitalization cannot be substituted with a zero sort
    # key. Stable catalog order is explicit until licensed cap facts are present.
    values=[{'symbol':stock_symbol(row['market'],row['code'].upper()),'code':row['code'].upper(),
        'name':row['name'],'market':row['market'],'price':None,'changePct':None} for row in found[:8]]
    all_rows={(row['market'],row['code'].upper()):row for row in rows}
    primary=next((row for row in values if row['market']=='US' and row['code'] in RELATED),None)
    if primary:
        related=[]
        for entry in RELATED[primary['code']]:
            stored=all_rows.get(('US',entry['code']));direction={'long':'做多','short':'做空','income':'收益策略'}[entry['kind']]
            name=stored['name'] if stored else re.sub(r'\s+',' ',primary['name']+' '+('2 倍' if re.search(r'2X',entry['badge'],re.IGNORECASE) else '')+direction+' ETF')
            related.append({'symbol':'us'+entry['code'],'code':entry['code'],'name':name,'market':'US','price':None,'changePct':None})
        related_codes={row['code'] for row in related}
        values=[primary,*related,*[row for row in values if row['code']!=primary['code'] and row['code'] not in related_codes]][:8]
    elif not values:
        code=text.strip(JS_WHITESPACE).upper()
        for root,entries in RELATED.items():
            entry=next((row for row in entries if row['code']==code),None)
            if entry:
                stored=all_rows.get(('US',code));underlying=all_rows.get(('US',root));direction={'long':'做多','short':'做空','income':'收益策略'}[entry['kind']]
                name=stored['name'] if stored else re.sub(r'\s+',' ',(underlying['name'] if underlying else root)+' '+('2 倍' if re.search(r'2X',entry['badge'],re.IGNORECASE) else '')+direction+' ETF')
                values=[{'symbol':'us'+code,'code':code,'name':name,'market':'US','price':None,'changePct':None}];break
    return values,{'scope':'confirmed_public_catalog_metadata','complete':False,'marketCapSortKnown':False}
