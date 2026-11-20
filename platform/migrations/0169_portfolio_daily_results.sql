CREATE TABLE portfolio_daily_results (
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_kind text NOT NULL CHECK (account_kind IN ('real','simulated')),
    valuation_day date NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    PRIMARY KEY (owner_id,account_kind,valuation_day,revision)
);

CREATE TABLE portfolio_daily_checks (
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_kind text NOT NULL CHECK (account_kind IN ('real','simulated')),
    valuation_day date NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id,account_kind,valuation_day)
);

CREATE INDEX cash_ledger_owner_kind_day ON cash_ledger_entries(owner_id,account_kind,occurred_at,id);

CREATE TABLE portfolio_daily_fx_fixings (
    valuation_day date NOT NULL,
    currency text NOT NULL,
    observation_id uuid NOT NULL,
    frozen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (valuation_day,currency),
    FOREIGN KEY (observation_id,currency) REFERENCES fx_values(observation_id,currency)
);
CREATE TRIGGER retain_portfolio_daily_fx_fixing BEFORE UPDATE OR DELETE ON portfolio_daily_fx_fixings
FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();

CREATE TABLE portfolio_record_versions (
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    record_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    action text NOT NULL CHECK (action IN ('baseline','create','update')),
    previous_value jsonb,
    current_value jsonb NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id,record_id,revision),
    FOREIGN KEY (owner_id,record_id) REFERENCES portfolio_records(owner_id,id) ON DELETE CASCADE,
    CHECK ((action='update')=(previous_value IS NOT NULL)),
    CHECK (current_value->>'id'=record_id AND current_value->>'owner_id'=owner_id)
);

INSERT INTO portfolio_record_versions(owner_id,record_id,revision,action,current_value)
SELECT owner_id,id,revision,'baseline',to_jsonb(p) FROM portfolio_records p;

CREATE FUNCTION capture_portfolio_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO portfolio_record_versions(owner_id,record_id,revision,action,previous_value,current_value)
    VALUES(NEW.owner_id,NEW.id,NEW.revision,CASE WHEN TG_OP='UPDATE' THEN 'update' ELSE 'create' END,
           CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));
    RETURN NEW;
END $$;
CREATE TRIGGER capture_portfolio_record_version AFTER INSERT OR UPDATE ON portfolio_records
FOR EACH ROW EXECUTE FUNCTION capture_portfolio_record_version();
