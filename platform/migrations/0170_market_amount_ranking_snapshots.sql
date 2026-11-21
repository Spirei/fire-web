CREATE TABLE market_amount_ranking_snapshots (
    market text PRIMARY KEY CHECK (market IN ('US','HK','CN')),
    next_attempt_at timestamptz NOT NULL,
    lease uuid,
    trade_day date,
    observed_at timestamptz,
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    CHECK ((result IS NULL) = (trade_day IS NULL)),
    CHECK ((result IS NULL) = (observed_at IS NULL))
);

CREATE INDEX trade_ledger_owner_kind_day ON trade_ledger(owner_id, account_kind, occurred_at, id);

ALTER TABLE market_demands DROP CONSTRAINT market_demands_origin_check;
ALTER TABLE market_demands ADD CONSTRAINT market_demands_origin_check
    CHECK (origin IN ('client','price.alert','portfolio.daily'));

CREATE TABLE portfolio_daily_source_checks (
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    market text NOT NULL CHECK (market IN ('US','HK','CN')),
    code text NOT NULL,
    next_check_at timestamptz NOT NULL,
    PRIMARY KEY (owner_id, market, code)
);
