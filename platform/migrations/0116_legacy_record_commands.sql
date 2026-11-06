CREATE TABLE portfolio_batch_previews (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL, session_hash text NOT NULL,
 collection_revision bigint NOT NULL CHECK(collection_revision>=0), records jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes', consumed_at timestamptz,
 PRIMARY KEY(owner_id,id)
);
CREATE TABLE portfolio_compatibility_receipts (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('create','update','delete','batch_delete','clear')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), child_requests uuid[] NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id)
);
CREATE FUNCTION reserve_portfolio_compatibility_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind IN ('create','update','delete') AND cardinality(NEW.child_requests)=1
    AND NEW.child_requests[1]=NEW.request_id AND EXISTS(SELECT 1 FROM portfolio_record_operations p
       WHERE p.owner_id=NEW.owner_id AND p.request_id=NEW.request_id AND p.result->>'kind'=NEW.kind) THEN
  RETURN NEW;
 END IF;
 INSERT INTO portfolio_request_reservations(owner_id,request_id,source_kind) VALUES(NEW.owner_id,NEW.request_id,'canonical');
 RETURN NEW;
END $$;
CREATE TRIGGER portfolio_compatibility_reservation BEFORE INSERT ON portfolio_compatibility_receipts
 FOR EACH ROW EXECUTE FUNCTION reserve_portfolio_compatibility_request();
CREATE TRIGGER immutable_portfolio_compatibility_receipts BEFORE UPDATE OR DELETE ON portfolio_compatibility_receipts
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
