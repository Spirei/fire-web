ALTER TABLE users ADD COLUMN revision uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE account_actions (
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(owner_id,request_id)
);
