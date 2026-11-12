"""US demand intent, independent from the observed provider price and clock."""
from datetime import UTC, datetime
from zoneinfo import ZoneInfo


def requested_session(now=None):
    local = (now or datetime.now(UTC)).astimezone(ZoneInfo('America/New_York'))
    minute, day = local.hour * 60 + local.minute, local.weekday()
    # No overnight demand on Friday evening/Saturday or before Sunday evening.
    # Holidays remain provider-authoritative: this is intent, never a quote fact.
    if day == 5 or day == 6 and minute < 1200 or day == 4 and minute >= 1200:
        return 'REGULAR'
    if minute < 240:
        return 'OVERNIGHT' if day in (0,1,2,3,4) else 'REGULAR'
    if minute < 570:return 'PRE'
    if minute < 960:return 'REGULAR'
    if minute < 1200:return 'AFTER'
    return 'OVERNIGHT'
