"""Owner-only non-secret descriptors; reads never register or fetch a source."""

from fastapi import HTTPException


def public_policy(policy):
    futu = policy.source == 'futu' and policy.source_version == 'futu-sdk-records-v1'
    yahoo = policy.source == 'yahoo' and policy.source_version == 'yahoo-chart-history-v1'
    controlled = policy.fixture and policy.source not in ('futu', 'yahoo')
    tencent=policy.source=='tencent'and policy.source_version=='tencent-quotes-v1'
    crypto = policy.source=='coingecko' and policy.source_version=='coingecko-latest-v1'
    purposes = set(policy.purposes)
    equity_markets = [market for market in policy.markets if market in ('US','HK','CN','JP','KR')]
    markets = [market for market in policy.markets if (market in ('US','HK','CN') if futu else yahoo or controlled)]
    minute_sessions = [session for session in ('REGULAR','ALL')
                       if (futu or controlled) and markets and 'bars.minute.'+session in purposes
                       and (session!='ALL' or 'US' in markets)]
    rt_sessions = [session for session in ('REGULAR','ALL')
                   if futu and markets and 'price_series.minute.'+session in purposes
                   and (session!='ALL' or 'US' in markets)]
    frames = [frame for frame in ('minute','day','week','month','quarter','year')
              if (futu or controlled) and markets and (bool(minute_sessions) if frame=='minute' else 'bars.'+frame in purposes)]
    capabilities, symbols = [], None
    if frames:
        capabilities.append({'instrument':'equity','markets':markets,'frames':frames,
                             'adjustments':['none','qfq','hfq'],'sessions':['REGULAR'],
                             'minuteSessions':minute_sessions})
    if yahoo:
        from .market_yahoo_history import CRYPTOS, INDEXES
        symbols = [{'market':value[0],'code':value[1],'instrument':'index','legacyKey':key}
                   for key,value in INDEXES.items() if value[0] in markets]
        if 'ASSET' in markets:
            symbols += [{'market':'ASSET','code':key,'instrument':'asset'} for key in CRYPTOS]
        if 'bars.day' in purposes:
            if equity_markets:
                capabilities.append({'instrument':'equity','markets':equity_markets,'frames':['day'],
                                     'adjustments':['none','qfq'],'sessions':['REGULAR']})
            for instrument in ('index','asset'):
                supported = list(dict.fromkeys(item['market'] for item in symbols if item['instrument']==instrument))
                if supported:
                    capabilities.append({'instrument':instrument,'markets':supported,'frames':['day'],
                                         'adjustments':['none'],'sessions':['REGULAR']})
            if capabilities:
                frames = ['day']
    instruments = list(dict.fromkeys(item['instrument'] for item in capabilities))
    if rt_sessions and 'equity' not in instruments:
        instruments.append('equity')
    history_markets = list(dict.fromkeys(market for item in capabilities for market in item['markets']))
    if rt_sessions:
        history_markets = list(dict.fromkeys(history_markets + markets))
    adjustments = [value for value in ('none','qfq','hfq') if any(value in item['adjustments'] for item in capabilities)]
    latest_markets = ['ASSET'] if crypto and 'ASSET' in policy.markets else equity_markets if yahoo or tencent else markets if futu or controlled else []
    latest = 'latest' in purposes and bool(latest_markets)
    latest_capabilities = [
        {'market':market,'sessions':['REGULAR','PRE','AFTER','OVERNIGHT'] if futu and market=='US' else ['REGULAR','PRE','AFTER'] if yahoo and market=='US' else ['REGULAR'],
         'instrument':'asset' if crypto else 'equity'}
        for market in latest_markets if latest
    ]
    latest_symbols = None
    if latest and crypto:
        from .market_crypto_latest import COINS
        latest_symbols = list(COINS)
    return {
        'id':policy.id,'source':policy.source,'sourceVersion':policy.source_version,
        'licenseRevision':policy.license_revision,'purposes':list(policy.purposes),'markets':list(policy.markets),
        'latestSupported':latest,'latestMarkets':latest_markets if latest else [],
        'latestInstruments':['asset' if crypto else 'equity'] if latest else [],
        'latestCapabilities':latest_capabilities,
        'timestampZones':[{'market':market,'timezone':zone}for market,zone in policy.timestamp_zones]if tencent else [],
        'latestSessions':list(dict.fromkeys(session for item in latest_capabilities for session in item['sessions'])),
        'latestTimestampAuthority':'provider_observation_not_verified_individual_trade_time',
        'latestCacheAuthority':'provider_cache_state_may_be_unknown',
        'latestSymbols':latest_symbols,
        'latestSessionAuthority':'provider_quote_observation_not_a_session_selection',
        'historyMarkets':history_markets,'historyFrames':frames,
        'historyKinds':(['bars'] if capabilities else []) + (['price_series'] if rt_sessions else []),
        # Flat fields are unions for old clients; the capability matrix defines valid combinations.
        'historyCapabilities':capabilities,'historySymbols':symbols,
        'historySymbolSelection':'validated_equity_code_and_explicit_fixed_non_equity_map' if yahoo else 'validated_market_security_code',
        'sourceSymbolMappings':[{'market':item[0],'code':item[1],'providerSymbol':item[2]} for item in policy.source_symbols],
        'historyInstruments':instruments,'historyAdjustments':adjustments,
        'historyMinuteSessions':minute_sessions,'priceSeriesSessions':rt_sessions,
        'priceSeriesAuthority':'provider_real_time_time_frame','priceSeriesHistoricalBackfill':False,
        'priceSeriesSubscriptions':'explicit_purpose_and_own_temporary_context_only',
    }


async def describe_sources(authority, who):
    async with authority.db.connection() as conn, conn.transaction():
        await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        from .security import lock_mutation_identity

        await lock_mutation_identity(conn, who, require_admin=False)
        current = await (await conn.execute("SELECT role FROM users WHERE id=%s", (who.id,))).fetchone()
        if not current or current["role"] != who.role:
            raise HTTPException(403, "账号权限已变化", headers={"X-Alcor-Retire-Context": "true"})
        installed = tuple(authority.policy_provider()) if authority.policy_provider else authority.policies
        policies = []
        for policy in installed:
            if policy.owner_id != who.id:
                continue
            try:
                valid = authority.policy(policy.id, who.id)
            except HTTPException:
                continue
            policies.append(public_policy(valid))
        policies.sort(key=lambda row: row["id"])
        rows = await (
            await conn.execute(
                """SELECT c.revision,c.policy_id,c.created_at,r.revision IS NOT NULL AS revoked
            FROM market_source_configs c LEFT JOIN market_source_revocations r ON r.owner_id=c.owner_id AND r.revision=c.revision
            WHERE c.owner_id=%s ORDER BY c.created_at DESC,c.revision LIMIT 1001""",
                (who.id,),
            )
        ).fetchall()
        if len(rows) > 1000:
            raise HTTPException(503, "行情来源记录超过读取范围")
        versions = []
        for row in rows:
            usable = False
            policy = None
            if not row["revoked"]:
                try:
                    _, policy = await authority.config(conn, who.id, row["revision"])
                    usable = True
                except HTTPException:
                    pass
            versions.append(
                {
                    "revision": str(row["revision"]),
                    "policyId": row["policy_id"],
                    "createdAt": row["created_at"].isoformat(),
                    "revoked": row["revoked"],
                    "usable": usable,
                    "policy": public_policy(policy) if usable else None,
                }
            )
        return {"policies": policies, "versions": versions, "automaticCollection": False}
