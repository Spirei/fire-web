-- Candidate only. Apply after the candidate receipt tables in an identity-checked isolated DB.
CREATE TABLE dividend_announcement_revisions (
 owner_id text NOT NULL REFERENCES users(id), revision uuid NOT NULL,
 request_id uuid NOT NULL, source text NOT NULL CHECK(source='futu'),
 market text NOT NULL CHECK(market IN ('US','HK','CN')), code text NOT NULL,
 source_event_id text NOT NULL, source_revision text NOT NULL,
 previous_revision uuid, version bigint NOT NULL CHECK(version>0),
 captured_at timestamptz NOT NULL, market_timezone text,
 date_basis text CHECK(date_basis IS NULL OR date_basis='source_calendar_date'),
 raw_payload text NOT NULL, raw_sha256 text NOT NULL CHECK(length(raw_sha256)=64),
 normalizer_version text NOT NULL, normalized jsonb NOT NULL, fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 PRIMARY KEY(owner_id,revision), UNIQUE(owner_id,request_id),
 UNIQUE(owner_id,source,market,code,source_event_id,version),
 UNIQUE(owner_id,source,market,code,source_event_id,revision),
 FOREIGN KEY(owner_id,source,market,code,source_event_id,previous_revision)
 REFERENCES dividend_announcement_revisions(owner_id,source,market,code,source_event_id,revision)
);
CREATE INDEX dividend_announcement_event ON dividend_announcement_revisions(owner_id,source,market,code,source_event_id,version DESC);
CREATE TRIGGER immutable_dividend_announcement BEFORE UPDATE OR DELETE ON dividend_announcement_revisions
FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

-- This is source evidence, never a position ledger or a second balance authority.
CREATE INDEX trade_dividend_replay ON trade_ledger(owner_id,record_id,before_record_revision);
CREATE TABLE dividend_history_evidence (
 owner_id text NOT NULL REFERENCES users(id), revision uuid NOT NULL,
 request_id uuid NOT NULL, record_id text NOT NULL, record_revision bigint NOT NULL,
 account_id text NOT NULL, account_kind text NOT NULL, market text NOT NULL, code text NOT NULL,
 ledger_tip_id uuid, source_reference text NOT NULL,
 document text NOT NULL, document_sha256 text NOT NULL CHECK(length(document_sha256)=64),
 input_payload jsonb NOT NULL, fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,revision), UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id),
 FOREIGN KEY(owner_id,ledger_tip_id) REFERENCES trade_ledger(owner_id,id)
);
CREATE TRIGGER immutable_dividend_history_evidence BEFORE UPDATE OR DELETE ON dividend_history_evidence
FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE TABLE dividend_receipt_links (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 receipt_request_id uuid NOT NULL, announcement_revision uuid NOT NULL,
 record_id text NOT NULL, allocated_gross numeric NOT NULL CHECK(allocated_gross>0 AND scale(allocated_gross)<=18),
 input_payload jsonb NOT NULL, fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id), UNIQUE(owner_id,receipt_request_id,announcement_revision),
 FOREIGN KEY(owner_id,receipt_request_id) REFERENCES dividend_receipts(owner_id,request_id),
 FOREIGN KEY(owner_id,announcement_revision) REFERENCES dividend_announcement_revisions(owner_id,revision),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id)
);
CREATE TRIGGER immutable_dividend_receipt_link BEFORE UPDATE OR DELETE ON dividend_receipt_links
FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE TABLE dividend_review_notices (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL,
 task_id uuid NOT NULL REFERENCES tasks(id), announcement_revision uuid NOT NULL,
 record_id text, coverage_revision uuid, contents jsonb NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,task_id,record_id),
 FOREIGN KEY(owner_id,announcement_revision) REFERENCES dividend_announcement_revisions(owner_id,revision),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,coverage_revision) REFERENCES dividend_history_evidence(owner_id,revision)
);
CREATE TRIGGER immutable_dividend_notice BEFORE UPDATE OR DELETE ON dividend_review_notices
FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK(kind IN (
 'system.diagnostics','backup.create','backup.verify','backup.restore',
 'dividends.source.import','dividends.entitlements.review'
));
