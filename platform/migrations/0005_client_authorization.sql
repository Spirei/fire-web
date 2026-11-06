CREATE TABLE registered_clients (
    client_id text PRIMARY KEY,
    name text NOT NULL,
    redirect_uris jsonb NOT NULL,
    scopes text[] NOT NULL,
    active boolean NOT NULL DEFAULT true,
    revision uuid NOT NULL,
    updated_by text NOT NULL REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE client_grants (
    id uuid PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id),
    client_id text NOT NULL REFERENCES registered_clients(client_id),
    client_revision uuid NOT NULL,
    session_version integer NOT NULL,
    device_name text NOT NULL,
    scopes text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_used_at timestamptz,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);
CREATE INDEX client_grants_owner ON client_grants(owner_id,created_at DESC);
CREATE TABLE authorization_codes (
    code_hash text PRIMARY KEY,
    request_id uuid NOT NULL,
    owner_id text NOT NULL REFERENCES users(id),
    client_id text NOT NULL REFERENCES registered_clients(client_id),
    client_revision uuid NOT NULL,
    session_version integer NOT NULL,
    redirect_uri text NOT NULL,
    challenge text NOT NULL,
    device_name text NOT NULL,
    scopes text[] NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    grant_id uuid REFERENCES client_grants(id),
    UNIQUE(owner_id,request_id)
);
CREATE TABLE client_tokens (
    access_hash text PRIMARY KEY,
    refresh_hash text NOT NULL UNIQUE,
    grant_id uuid NOT NULL REFERENCES client_grants(id),
    access_expires_at timestamptz NOT NULL,
    refresh_expires_at timestamptz NOT NULL,
    refresh_used_at timestamptz
);
CREATE INDEX client_tokens_grant ON client_tokens(grant_id);
