CREATE TABLE identity_mail_outbox (
    id uuid PRIMARY KEY,
    user_id text REFERENCES users(id),
    challenge_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('email-registration','email-verification','password-reset','email-change')),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','unknown','cancelled')),
    ciphertext text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    lease_owner uuid,
    lease_until timestamptz,
    error_code text,
    CHECK (expires_at > created_at)
);
CREATE INDEX identity_mail_queue ON identity_mail_outbox(created_at,id) WHERE status='queued';
CREATE INDEX identity_mail_owner ON identity_mail_outbox(user_id,created_at DESC);
CREATE INDEX identity_mail_challenge ON identity_mail_outbox(challenge_id);
