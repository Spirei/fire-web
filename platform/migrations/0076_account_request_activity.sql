-- Daily per-account metrics. No URLs, headers, tokens, or request bodies are stored.
CREATE TABLE account_request_activity_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 observed_since timestamptz NOT NULL DEFAULT clock_timestamp(),
 dropped bigint NOT NULL DEFAULT 0 CHECK (dropped >= 0)
);
INSERT INTO account_request_activity_state(singleton) VALUES(true);
CREATE TABLE account_request_activity (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 day date NOT NULL,
 requests bigint NOT NULL CHECK (requests >= 0),
 PRIMARY KEY(user_id,day)
);
-- A retried batch must not increment totals twice after an ambiguous commit.
CREATE TABLE account_request_activity_batches (
 id uuid PRIMARY KEY,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
