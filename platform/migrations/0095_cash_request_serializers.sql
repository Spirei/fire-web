-- Terminal cash receipts and posted entries share a durable original-UUID serialization point.
CREATE TABLE cash_request_serializers (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 last_acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id)
);
CREATE FUNCTION guard_terminal_cash_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE terminal text;
BEGIN
 -- UPSERT deliberately locks/updates the same tuple. A stale repeatable-read
 -- transaction must serialize or fail, never miss a just-committed tombstone.
 INSERT INTO cash_request_serializers(owner_id,request_id) VALUES(NEW.owner_id,NEW.request_id)
 ON CONFLICT(owner_id,request_id) DO UPDATE SET last_acquired_at=clock_timestamp();
 IF TG_TABLE_NAME='cash_ledger_entries' THEN
  SELECT result->>'state' INTO terminal FROM cash_ledger_operations
   WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id;
  IF terminal IN ('closed','failed') THEN
   RAISE EXCEPTION 'cash request has a terminal nonexecution receipt' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.result->>'state' IN ('closed','failed') AND EXISTS(
   SELECT 1 FROM cash_ledger_entries WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id
  ) THEN
   RAISE EXCEPTION 'posted cash cannot be marked unexecuted' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_entry_terminal_guard BEFORE INSERT ON cash_ledger_entries
 FOR EACH ROW EXECUTE FUNCTION guard_terminal_cash_request();
CREATE TRIGGER cash_receipt_terminal_guard BEFORE INSERT ON cash_ledger_operations
 FOR EACH ROW EXECUTE FUNCTION guard_terminal_cash_request();
