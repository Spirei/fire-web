CREATE TABLE user_profiles (
    user_id text PRIMARY KEY REFERENCES users(id),
    display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 80),
    avatar bytea CHECK (octet_length(avatar) <= 49152),
    revision uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_events_actor_date ON audit_events (actor_id, created_at);
