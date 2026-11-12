"""Exact index identities shared by provider adapters and the signed-in ticker."""

# Presentation names and Eastmoney IDs survive migration; their provider symbols
# do not become ordinary equity codes (000001 is also a different SZ security).
INDEXES = {
    'dji': ('US', 'DJI', '^DJI', '100.DJIA'),
    'spx': ('US', 'SPX', '^GSPC', '100.SPX'),
    'ndx': ('US', 'IXIC', '^IXIC', '100.NDX'),
    'hsi': ('HK', 'HSI', '^HSI', '100.HSI'),
    'sse': ('CN', '000001', '000001.SS', '1.000001'),
    'szse': ('CN', '399001', '399001.SZ', '0.399001'),
    'n225': ('JP', 'N225', '^N225', '100.N225'),
    'ks11': ('KR', 'KS11', '^KS11', '100.KS11'),
    'sti': ('SG', 'STI', '^STI', '100.STI'),
}


def index_identity(market, secid):
    matches = [(row[0], row[1]) for row in INDEXES.values() if row[0] == market and row[3] == secid]
    return matches[0] if len(matches) == 1 else None


def provider_index(market, code, provider):
    position = {'yahoo': 2, 'eastmoney': 3}[provider]
    matches = [row[position] for row in INDEXES.values() if row[:2] == (market, code)]
    if len(matches) != 1:
        raise ValueError('fixed_index_identity_required')
    return matches[0]
