CREATE TABLE card_preference_collections (
 owner_id text PRIMARY KEY REFERENCES users(id),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE card_preference_tags (
 owner_id text NOT NULL REFERENCES users(id),
 card_key text NOT NULL CHECK(length(card_key) BETWEEN 1 AND 600),
 tags jsonb NOT NULL CHECK(jsonb_typeof(tags)='array'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,card_key)
);
CREATE TABLE card_preference_holdings (
 owner_id text NOT NULL REFERENCES users(id),
 card_key text NOT NULL CHECK(length(card_key) BETWEEN 1 AND 600),
 held boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,card_key)
);
CREATE TABLE card_preference_operations (
 owner_id text NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 fingerprint text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id)
);
