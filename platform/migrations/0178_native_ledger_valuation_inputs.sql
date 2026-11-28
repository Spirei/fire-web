CREATE TABLE native_ledger_valuation_inputs (
    owner_id text NOT NULL REFERENCES users(id),
    revision bigint NOT NULL,
    recorded_at timestamptz NOT NULL,
    positions jsonb NOT NULL CHECK (jsonb_typeof(positions) = 'array'),
    owner_cash jsonb NOT NULL CHECK (jsonb_typeof(owner_cash) = 'array'),
    PRIMARY KEY (owner_id, revision)
);

CREATE INDEX native_ledger_valuation_inputs_as_of
    ON native_ledger_valuation_inputs (owner_id, recorded_at DESC, revision DESC);

CREATE FUNCTION capture_native_ledger_valuation_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    cash jsonb := jsonb_path_query_array(NEW.snapshot, '$.cash[*] ? (@.brokerAccountId == null)');
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.snapshot->'positions' = NEW.snapshot->'positions'
       AND jsonb_path_query_array(OLD.snapshot, '$.cash[*] ? (@.brokerAccountId == null)') = cash THEN
        RETURN NEW;
    END IF;
    INSERT INTO native_ledger_valuation_inputs (owner_id, revision, recorded_at, positions, owner_cash)
    VALUES (NEW.owner_id, NEW.revision, NEW.updated_at, NEW.snapshot->'positions', cash);
    RETURN NEW;
END;
$$;

INSERT INTO native_ledger_valuation_inputs (owner_id, revision, recorded_at, positions, owner_cash)
SELECT owner_id, revision, updated_at, snapshot->'positions',
       jsonb_path_query_array(snapshot, '$.cash[*] ? (@.brokerAccountId == null)')
FROM native_ledger_heads;

CREATE TRIGGER native_ledger_valuation_input AFTER INSERT OR UPDATE OF revision ON native_ledger_heads
    FOR EACH ROW EXECUTE FUNCTION capture_native_ledger_valuation_input();
