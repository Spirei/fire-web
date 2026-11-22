CREATE TABLE native_synced_orders (
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled', 'expired', 'deleted')),
    occurred_at timestamptz NOT NULL,
    item jsonb NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id, order_id),
    CHECK (item->>'tradeId' = order_id::text AND item->>'status' = status)
);

CREATE INDEX native_synced_orders_by_time
    ON native_synced_orders (owner_id, occurred_at DESC, order_id DESC)
    WHERE status <> 'deleted';
