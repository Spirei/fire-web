"""Exact stored nonfinancial values and complete raw IDs; no name-based matching."""

import re
from collections import Counter
from datetime import UTC, datetime

from fastapi import HTTPException

from .market_contract import source_time
from .source_snapshot import canonical, sha
from .watchlists import MARKETS, name_value


def text(row,key):
    cell=row.get(key,{})
    return None if cell.get('null') else cell.get('text')


def integer(row,key):
    cell=row.get(key,{})
    value=text(row,key)
    if not isinstance(value,str) or not re.fullmatch('-?(?:0|[1-9][0-9]*)',value) or cell.get('storageType') not in ('integer','bigint','smallint','INTEGER'):raise ValueError('stored_integer_required')
    result=int(value)
    if abs(result)>9007199254740991:raise ValueError('stored_integer_out_of_range')
    return result


def index(snapshot):
    groups={};members={};blockers=[];all_rows={'watch_groups':[],'records':[]}
    for table,target in [('watch_groups',groups),('records',members)]:
        rows=snapshot['tables'][table];counts=Counter(text(row,'id') for row in rows)
        for position,row in enumerate(rows):
            original=text(row,'id');reason=None
            value={'originalId':original,'rowSha256':sha(canonical(row)),'sequence':position}
            if table=='records':value['groupId']=text(row,'watch_group_id') or ''
            if not isinstance(original,str) or not 1<=len(original.encode('utf-16-le',errors='surrogatepass'))//2<=100 or any(ord(c)<32 for c in original) or table=='watch_groups' and (original=='__all' or not re.fullmatch('[A-Za-z0-9_-]{1,100}',original)):reason='unsupported_original_id'
            elif counts[original]!=1:reason='duplicate_original_id'
            elif text(row,'user_id')!=snapshot['source']['owner']:reason='source_owner_mismatch'
            elif table=='watch_groups':
                try:
                    name,key=name_value(text(row,'name'));sort=integer(row,'sort');visible=integer(row,'visible');kind=text(row,'kind');market=text(row,'market') or ''
                    if not 0<=sort<=2147483647 or visible not in (-1,0,1) or kind not in ('market','custom') or kind=='market' and market not in dict(MARKETS) or kind=='custom' and market:raise ValueError('group_metadata_invalid')
                    value.update(name=name,nameKey=key,sort=sort,visible=visible,kind=kind,market=market,iconState='pending_file_provenance' if text(row,'icon') else 'empty')
                except (ValueError,HTTPException,UnicodeError):reason='group_metadata_invalid'
            else:
                group=text(row,'watch_group_id') or ''
                try:
                    sort=integer(row,'watch_group_sort') if group else 0
                    if not 0<=sort<=2147483647:raise ValueError()
                    value.update(groupId=group,sort=sort,sourceOrder=position,sourceUpdatedAt=None,metadataTimeState='unknown',orderingState='known')
                    stored=text(row,'updated_at')
                    try:
                        stamp=datetime.fromisoformat(stored)
                        stamp=stamp.astimezone(UTC) if stamp.tzinfo else source_time(stored,snapshot['source']['timezone'])
                        value.update(sourceUpdatedAt=stamp.isoformat(),metadataTimeState='known')
                    except (ValueError,TypeError,KeyError):pass
                except ValueError:reason='member_metadata_invalid'
            if reason:
                value['blocker']=reason;blockers.append({'table':table,'originalId':original,'position':position,'reason':reason})
            elif original not in target:target[original]=value
            all_rows[table].append(value)
    keys=Counter((row.get('groupId'),row.get('sort'),text(snapshot['tables']['records'][row['sequence']],'updated_at')) for row in members.values())
    for row in members.values():
        key=(row.get('groupId'),row.get('sort'),text(snapshot['tables']['records'][row['sequence']],'updated_at'))
        if row.get('groupId') and keys[key]>1:row.update(orderingState='unknown_equal_source_keys',sourceOrder=None)
    markets=Counter(row['market'] for row in groups.values() if row['kind']=='market')
    names=Counter(row['nameKey'] for row in groups.values())
    for row in groups.values():
        if row['kind']=='market' and markets[row['market']]>1:row['blocker']='duplicate_source_market'
        elif names[row['nameKey']]>1:row['blocker']='duplicate_source_normalized_name'
    return {'groupIndex':groups,'memberIndex':members,'groupRows':all_rows['watch_groups'],'memberRows':all_rows['records'],'normalizationBlockers':blockers,'counts':{name:len(rows) for name,rows in snapshot['tables'].items()},'metadataCapturedComplete':True,'membershipMappingComplete':False,'iconBytesVerified':False}
