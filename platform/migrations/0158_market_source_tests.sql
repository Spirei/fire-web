-- Explicit quote probes are admitted once; an interrupted probe is never replayed.
CREATE TABLE market_source_tests (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN ('futu','tencent','eastmoney','yahoo')),
 source_revision uuid, policy_fingerprint text,
 result jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,source_revision) REFERENCES market_source_configs(owner_id,revision)
);
CREATE INDEX market_source_tests_latest ON market_source_tests(owner_id,provider,created_at DESC);
