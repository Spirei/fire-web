CREATE TABLE deployment_configuration (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    revision uuid NOT NULL DEFAULT gen_random_uuid(),
    repository text NOT NULL,
    token_ciphertext text,
    oauth_ciphertext text,
    github_account text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE deployment_config_actions (
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    PRIMARY KEY(owner_id,request_id)
);
CREATE TABLE deployment_oauth_states (
    state_hash text PRIMARY KEY,
    cookie_hash text NOT NULL,
    owner_id text NOT NULL REFERENCES users(id),
    session_hash text NOT NULL,
    config_revision uuid,
    callback text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);
ALTER TABLE deployment_builds ADD COLUMN repository text NOT NULL DEFAULT '';
