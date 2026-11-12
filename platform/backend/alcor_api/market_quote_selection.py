"""Business reads share the configured source order and observed US session.

Canonical source-specific reads retain BatchQuotes' explicit ambiguity rules.
This adapter never registers demand, collects a source or substitutes saved marks.
"""

from .market_quote_reads import BatchQuotes
from .market_sessions import requested_session


async def configured_quotes(authority, who, items, source_revision=None, *, regular=False):
    now = authority.clock() if authority.clock else None
    return await BatchQuotes(authority).read(
        who, items, source_revision,
        source_preference=None if source_revision is not None else
            getattr(authority.db.settings, '_legacy_quote_source', None) or 'auto',
        session='REGULAR' if regular else None,
        preferred_session=None if regular else requested_session(now),
        legacy_instruments=True,
    )
