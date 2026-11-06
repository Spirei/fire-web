CREATE TABLE users (
    id text PRIMARY KEY,
    username text NOT NULL CHECK (length(username) BETWEEN 1 AND 80),
    email text NOT NULL DEFAULT '',
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'user')),
    active boolean NOT NULL DEFAULT true,
    session_version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower ON users (lower(email)) WHERE email <> '';
CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    client_id text NOT NULL DEFAULT 'new-web' CHECK (client_id = 'new-web'),
    session_version integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE TABLE auth_rate_limits (
    bucket text PRIMARY KEY,
    window_start timestamptz NOT NULL,
    attempts integer NOT NULL
);
CREATE TABLE audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id text REFERENCES users(id),
    action text NOT NULL,
    target_id text,
    request_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE tasks (
    id uuid PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('system.diagnostics')),
    status text NOT NULL CHECK (status IN ('queued','running','cancel_requested','cancelled','succeeded','failed')),
    attempts integer NOT NULL DEFAULT 0,
    lease_version bigint NOT NULL DEFAULT 0,
    lease_owner uuid,
    lease_until timestamptz,
    result jsonb,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at timestamptz,
    finished_at timestamptz,
    UNIQUE (owner_id, request_id)
);
CREATE INDEX tasks_claim ON tasks (status, created_at);
CREATE INDEX tasks_owner ON tasks (owner_id, created_at DESC, id DESC);
CREATE TABLE task_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES tasks(id),
    phase text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE worker_heartbeats (
    worker_id uuid PRIMARY KEY,
    version text NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
