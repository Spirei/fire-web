"""Original calendar-led search hints, from current independently public saved pages only."""
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from .public_reference import PublicReference
from .public_earnings_reference import PublicEarnings


async def event_hints(db,instructions,now=None):
    if not re.search(r'美股|纳斯达克|标普|Wall Street|Nasdaq|S&P|US stocks|U\.S\. stocks',instructions,re.I):return []
    now=now or datetime.now(UTC);today=now.astimezone(ZoneInfo('America/New_York')).date();start=today-timedelta(days=3)
    service=PublicReference(db,policy_provider=lambda:db.settings.public_reference_policies,
        adapters={'earnings.calendar':PublicEarnings(lambda:db.settings.public_earnings_targets)})
    rows=[]
    for month in sorted({start.strftime('%Y-%m'),today.strftime('%Y-%m')}):
        try:
            page=await service.read('earnings.calendar',{'market':'US','month':month})
            observed=datetime.fromisoformat(page['updatedAt'])
            if not now-timedelta(days=7)<=observed<=now+timedelta(minutes=1):continue
            for item in page['items'][:1000]:
                symbol=item.get('symbol');name=item.get('name');day=item.get('date')
                try:cap=Decimal(str(item['marketCap']))
                except (InvalidOperation,ValueError,KeyError):continue
                if not cap.is_finite()or cap<20000000000 or not isinstance(symbol,str)or not re.fullmatch(r'[A-Z][A-Z0-9.-]{0,9}',symbol)or not isinstance(name,str)or len(name.encode('utf-16-le'))//2>100 or not isinstance(day,str):continue
                if start.isoformat()<=day<=today.isoformat():rows.append((cap,{'symbol':symbol,'name':name,'scheduledDate':day,'timing':str(item.get('time')or'unknown')[:30],
                    'authority':'public_calendar_hint_not_evidence','licenseRevision':page.get('licenseRevision'),'observedAt':page['updatedAt']}))
        except (HTTPException,ValueError,TypeError,KeyError):continue
    answer=[];seen=set()
    for _,row in sorted(rows,key=lambda pair:pair[0],reverse=True):
        if row['symbol']not in seen:answer.append(row);seen.add(row['symbol'])
        if len(answer)==8:break
    return answer
