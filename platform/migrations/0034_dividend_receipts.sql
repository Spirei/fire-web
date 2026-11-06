-- Actual owner-confirmed statement events; never estimated dividend entitlements.
CREATE TABLE dividend_receipt_previews (
 token_hash text PRIMARY KEY REFERENCES trade_previews(token_hash),
 owner_id text NOT NULL REFERENCES users(id), fingerprint text NOT NULL
);
CREATE TABLE dividend_receipts (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 trade_id uuid NOT NULL, account_id text NOT NULL, record_id text NOT NULL,
 event_reference text NOT NULL CHECK(length(event_reference) BETWEEN 1 AND 160),
 fingerprint text NOT NULL, input_payload jsonb NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 PRIMARY KEY(owner_id,request_id), UNIQUE(owner_id,account_id,record_id,event_reference),
 FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id)
);
CREATE TRIGGER immutable_dividend_receipt BEFORE UPDATE OR DELETE ON dividend_receipts
FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
