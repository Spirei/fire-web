-- Single-PG authoritative opening checkpoints and append-only structured ledger events.
CREATE TABLE owner_ledger_checkpoints (
    owner_id text NOT NULL REFERENCES users(id),
    checkpoint_version bigint NOT NULL CHECK (checkpoint_version BETWEEN 1 AND 9007199254740991),
    request_id uuid NOT NULL,
    account_kind text NOT NULL CHECK (account_kind IN ('real')),
    source_authority text NOT NULL CHECK (char_length(source_authority) BETWEEN 1 AND 120),
    source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
    cash_balances jsonb NOT NULL CHECK (jsonb_typeof(cash_balances) = 'object'),
    position_costs jsonb NOT NULL CHECK (jsonb_typeof(position_costs) = 'array'),
    note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id, checkpoint_version),
    UNIQUE (owner_id, request_id)
);
CREATE TRIGGER owner_ledger_checkpoint_retained
    BEFORE UPDATE OR DELETE ON owner_ledger_checkpoints
    FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();

CREATE TABLE owner_ledger_events (
    owner_id text NOT NULL REFERENCES users(id),
    seq bigint NOT NULL CHECK (seq BETWEEN 1 AND 9007199254740991),
    ledger_revision bigint CHECK (ledger_revision IS NULL OR ledger_revision BETWEEN 1 AND 9007199254740991),
    request_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN (
        'adopt', 'trade', 'merge', 'repair_baseline', 'reconcile_adjustment', 'opening_checkpoint'
    )),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    orders jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(orders) = 'array'),
    positions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(positions) = 'array'),
    cash jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cash) = 'array'),
    note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id, seq),
    UNIQUE (owner_id, request_id)
);
CREATE INDEX owner_ledger_events_owner_kind_idx ON owner_ledger_events (owner_id, kind, seq DESC);
CREATE TRIGGER owner_ledger_event_retained
    BEFORE UPDATE OR DELETE ON owner_ledger_events
    FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();

-- Lossless backfill of existing native ledger transactions into structured events.
INSERT INTO owner_ledger_events (
    owner_id, seq, ledger_revision, request_id, kind, occurred_at, orders, positions, cash, note, created_at
)
SELECT
    t.owner_id,
    t.revision,
    t.revision,
    t.request_id,
    CASE
        WHEN t.event->>'kind' IN ('adopt', 'trade', 'merge', 'repair_baseline', 'reconcile_adjustment', 'opening_checkpoint')
        THEN t.event->>'kind'
        ELSE 'trade'
    END,
    t.created_at,
    COALESCE(CASE WHEN jsonb_typeof(t.event->'orders') = 'array' THEN t.event->'orders' END, '[]'::jsonb),
    COALESCE(
        CASE WHEN jsonb_typeof(t.event->'positionUpdates') = 'array' THEN t.event->'positionUpdates' END,
        CASE WHEN jsonb_typeof(t.event->'positions') = 'array' THEN t.event->'positions' END,
        '[]'::jsonb
    ),
    COALESCE(
        CASE WHEN jsonb_typeof(t.event->'cashUpdates') = 'array' THEN t.event->'cashUpdates' END,
        CASE WHEN jsonb_typeof(t.event->'cash') = 'array' THEN t.event->'cash' END,
        '[]'::jsonb
    ),
    LEFT(COALESCE(t.event->>'note', ''), 200),
    t.created_at
FROM native_ledger_transactions t
ON CONFLICT DO NOTHING;
