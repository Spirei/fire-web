"""Public calendar adapter over explicitly licensed, independent saved source pages."""
import calendar
from datetime import date

from .earnings_calendar import calendar_query
from .earnings_calendar_protocol import SOURCE_VERSION, MARKETS, Target, PageFailure, fetch, parse, scope


class PublicEarnings:
    source_version = SOURCE_VERSION

    def __init__(self, target_provider):
        self.target_provider = target_provider

    def normalize(self, raw, collect=False):
        allowed = {'market','month','pageKey'} if collect else {'market','month'}
        if not isinstance(raw,dict) or set(raw)-allowed:
            raise ValueError('public_calendar_query')
        if not isinstance(raw.get('market','US'),str) or collect and not isinstance(raw.get('month'),str):
            raise ValueError('public_calendar_explicit_scope')
        market,month=calendar_query(raw.get('market','US').upper(),raw.get('month'))
        value={'market':market,'month':month}
        if collect:
            if set(raw)!=allowed:
                raise ValueError('public_calendar_explicit_page')
            scope(market,month,raw['pageKey'])
            value['pageKey']=raw['pageKey']
        return value

    def scope(self, query):
        return {key:query[key] for key in ('market','month')}

    def target(self, policy):
        values=self.target_provider()
        if not isinstance(values,(list,tuple)) or len(values)>128:
            raise ValueError('public_calendar_targets')
        targets=[raw if isinstance(raw,Target) else Target(**raw) for raw in values]
        matches=[target for target in targets if target.id==policy.target_id]
        if len(matches)!=1 or matches[0].fingerprint!=policy.target_fingerprint:
            raise ValueError('public_calendar_target_changed')
        return matches[0].validate()

    def validate(self, policy, target, query):
        if (policy.source_version!=self.source_version or policy.kind!='earnings.calendar'
                or query['market'] not in policy.markets or query['month'] not in policy.months
                or MARKETS[target.source]!=query['market']):
            raise ValueError('public_calendar_scope_not_licensed')
        if 'pageKey' in query:
            scope(query['market'],query['month'],query['pageKey'])

    async def acquire(self, target, query, *, before_request=None):
        if before_request is not None:
            await before_request()
        try:
            raw=await fetch(target,query['market'],query['month'],query['pageKey'])
            status,complete=200,True
        except PageFailure as exc:
            raw,status,complete=exc.raw,exc.status,exc.complete
        return [{'kind':'calendar','raw':raw,'status':status,'complete':complete}]

    def project(self, pages, query):
        if (len(pages)!=1 or pages[0]['kind']!='calendar'
                or pages[0]['status']!=200 or pages[0]['complete'] is not True):
            raise ValueError('public_calendar_original_incomplete')
        return parse(pages[0]['raw'],query['market'],query['month'],query['pageKey'])

    def combine(self, observations, query):
        # The core supplies ascending captures after verifying every retained byte.
        selected={row['query']['pageKey']:row for row in observations}
        items,seen=[],set()
        for row in selected.values():
            for item in row['payload']['items']:
                identity=tuple(item[key] for key in ('symbol','date','time','quarter'))
                if identity not in seen:
                    seen.add(identity);items.append(item)
        items.sort(key=lambda row:(row['date'],row['symbol'],row['time']))
        market,month=query['market'],query['month']
        year,number=map(int,month.split('-'))
        days=[date(year,number,n).isoformat() for n in range(1,calendar.monthrange(year,number)[1]+1)]
        return {'market':market,'month':month,'items':items,'state':'observed',
                'updatedAt':max((row['observedAt'] for row in selected.values()),default=None),
                'sourceRevision':None,'sourcePageId':None,'sourcePageIds':[],
                'licenseRevision':next(iter(selected.values()))['licenseRevision'] if selected else None,
                'coverage':{'complete':False,'missingDates':[day for day in days if day not in selected] if market=='US' else [],
                            'basis':'provider_calendar_schedule','observedPageKeys':list(selected),
                            'pageResults':[{'pageKey':key,'state':'observed','nextPage':row['payload'].get('nextPage')} for key,row in selected.items()],
                            'calendarCompletenessVerified':False},
                'retainedSources':[],'automaticCollection':False,'collectionOnRead':False}
