CREATE TABLE native_synced_fills (
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trade_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    fill jsonb NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id, trade_id),
    CHECK (jsonb_typeof(fill) = 'object' AND fill->>'tradeId' = trade_id::text)
);
