-- Current Fire UI metadata, owned by the same PG authority as the native domain.
CREATE TABLE user_search_history_state (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE user_search_history (
    id uuid PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query_key text NOT NULL,
    query text NOT NULL CHECK (char_length(query) BETWEEN 1 AND 80),
    searched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(user_id, query_key)
);
CREATE INDEX user_search_history_recent ON user_search_history(user_id, searched_at DESC, id DESC);
CREATE TABLE fire_catalog_preferences (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    broker_order jsonb NOT NULL DEFAULT '[]'
);
INSERT INTO fire_catalog_preferences(singleton) VALUES(true);
CREATE TABLE fire_catalog_operations (
    actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(actor_id, request_id)
);
