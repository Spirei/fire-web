"""Coalesce generated quote intent, never caller UUIDs or quote observations."""

from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException

from .market_contract import canonical, digest


def observation_bucket(at):
    # A visible reader renews before the existing 90-second hot lease expires.
    return int(at.timestamp()) // 30


async def generated_observation_id(authority, who, items, *, selected=None, session=None,
                                   source_preference=None, instrument=None):
    principal = str(getattr(who, 'grant_id', None) or 'web:' + who.token_hash)
    async with authority.db.connection() as conn:
        rows = await (await conn.execute('''SELECT c.revision,c.policy_fingerprint,c.session_version,r.created_at AS revoked_at,
            u.session_version AS current_version,u.active,g.id AS source_grant,g.scope AS source_scope,
            g.revoked_at AS grant_revoked_at,
            g.expires_at>clock_timestamp() AND g.created_at+interval '90 days'>clock_timestamp() AS grant_time_valid,
            CASE WHEN g.passkey_id IS NULL THEN true ELSE EXISTS(
              SELECT 1 FROM identity_passkeys p WHERE p.id=g.passkey_id AND p.user_id=g.user_id) END AS passkey_present
            FROM market_source_configs c LEFT JOIN market_source_revocations r
            ON r.owner_id=c.owner_id AND r.revision=c.revision
            JOIN users u ON u.id=c.owner_id
            LEFT JOIN identity_app_grants g ON g.id=c.native_grant_id
            WHERE c.owner_id=%s ORDER BY c.revision LIMIT 1001''', (who.id,))).fetchall()
        if len(rows) > 1000:
            raise HTTPException(503, '当前来源版本超过核对范围')
        state = await (await conn.execute('''WITH wanted AS (
            SELECT * FROM unnest(%s::text[],%s::text[]) item(market,code)
            ) SELECT clock_timestamp() AS at,
            (SELECT max(revoked_at) FROM market_demands WHERE owner_id=%s AND principal=%s) AS cancelled_at,
            (SELECT jsonb_agg(jsonb_build_array(expired.stream_id,expired.revision) ORDER BY expired.stream_id)
             FROM (SELECT d.stream_id,d.revision FROM market_demands d
               JOIN market_streams s ON s.owner_id=d.owner_id AND s.id=d.stream_id
               JOIN wanted ON wanted.market=s.query->>'market' AND wanted.code=s.query->>'code'
               WHERE d.owner_id=%s AND d.principal=%s AND d.revoked_at IS NULL
                 AND (d.hot_until<=clock_timestamp() OR d.expires_at<=clock_timestamp())
                 AND s.query->>'kind'='latest' ORDER BY d.stream_id LIMIT 10001) expired) AS expired,
            (SELECT max(t.finished_at) FROM tasks t JOIN market_data_jobs j ON j.task_id=t.id
             JOIN market_streams s ON s.owner_id=j.owner_id AND s.id=j.stream_id
             JOIN wanted ON wanted.market=s.query->>'market' AND wanted.code=s.query->>'code'
             WHERE t.owner_id=%s AND s.owner_id=%s AND t.kind='market.latest' AND t.status='failed'
               AND s.query->>'kind'='latest' AND t.finished_at>clock_timestamp()-interval '60 seconds') AS failed_at''',
            ([i['market'] for i in items], [i['code'] for i in items], who.id, principal,
             who.id, principal, who.id, who.id))).fetchone()
        if len(state['expired'] or []) > 10000:
            raise HTTPException(503, '行情需求超过完整核对范围')
    policies = []
    for policy in authority.policy_provider() if authority.policy_provider else authority.policies:
        if policy.owner_id != who.id:
            continue
        try:
            authority.policy(policy.id, who.id, policy.fingerprint)
            available = True
        except HTTPException:
            available = False
        policies.append((policy.id, policy.fingerprint, available))
    scope = {
        'instance': str(authority.db.settings.instance_id), 'owner': who.id,
        'principal': principal, 'credential': who.token_hash,
        'items': items, 'selected': str(selected) if selected else None,
        'session': session, 'instrument': instrument, 'preference': source_preference,
        'order': getattr(authority.db.settings, '_legacy_quote_order', None),
        'policies': sorted(policies),
        'configs': [[str(row[k]) for k in ('revision', 'policy_fingerprint', 'session_version', 'revoked_at',
            'current_version', 'active', 'source_grant', 'source_scope', 'grant_revoked_at', 'grant_time_valid', 'passkey_present')] for row in rows],
        'cancelled': str(state['cancelled_at']), 'failed': str(state['failed_at']),
        'expired': state['expired'],
        'bucket': observation_bucket(state['at']),
    }
    # The original durable receipt is returned by Subscriptions.mutate. Nothing
    # labels an uncommitted intent accepted, changes source time, or renews it
    # from the Worker. Every HTTP quote still checks current identity/license.
    return uuid5(NAMESPACE_URL, 'alcor:generated-quote-observation:1:' + digest(scope))


def generated_history_observation_id(who, items, *, days, minute, adjust, at):
    """Coalesce automatic chart registration without touching explicit IDs."""
    principal = str(getattr(who, 'grant_id', None) or 'web:' + who.token_hash)
    scope = {
        'owner': who.id, 'principal': principal, 'items': items, 'days': days,
        'minute': minute, 'adjust': adjust, 'bucket': observation_bucket(at),
    }
    return uuid5(NAMESPACE_URL, 'alcor:generated-history-observation:1:' + digest(canonical(scope)))
