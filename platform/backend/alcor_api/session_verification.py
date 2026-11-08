"""Reuse an actual strong Web login, never the mere presence of an enrolled key."""
SESSION_PROOF = 'verified-session-v1'


async def verified(conn, who):
    row = await (await conn.execute(
        """SELECT s.auth_method='passkey' AND EXISTS(
          SELECT 1 FROM identity_passkeys k JOIN identity_passkey_config c ON c.singleton
          WHERE k.id=s.passkey_id AND k.user_id=u.id AND c.enabled AND k.rp_id=c.rp_id
        ) OR s.auth_method='totp' AND EXISTS(
          SELECT 1 FROM identity_security f WHERE f.user_id=u.id AND f.totp_enabled
        ) AS ok FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=%s AND s.user_id=%s AND s.expires_at>clock_timestamp()
          AND s.session_version=u.session_version AND u.active""", (who.token_hash, who.id),
    )).fetchone()
    return bool(row and row['ok'])
