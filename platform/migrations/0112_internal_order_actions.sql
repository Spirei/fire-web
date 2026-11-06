-- Append-only original intent context and explicit amendment authorization.
CREATE TABLE internal_order_contexts (
 owner_id text NOT NULL, order_id uuid NOT NULL, order_revision bigint NOT NULL,
 request_id uuid NOT NULL, draft jsonb NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,order_id,order_revision),
 FOREIGN KEY(owner_id,order_id) REFERENCES internal_orders(owner_id,id)
);
CREATE TABLE internal_order_actions (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL, order_id uuid NOT NULL,
 action text NOT NULL CHECK(action='amend'), before_revision bigint NOT NULL, after_revision bigint NOT NULL,
 before_snapshot jsonb NOT NULL, after_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id),
 UNIQUE(owner_id,order_id,after_revision),
 FOREIGN KEY(owner_id,order_id) REFERENCES internal_orders(owner_id,id),
 CHECK(after_revision=before_revision+1)
);
CREATE TRIGGER immutable_internal_order_contexts BEFORE UPDATE OR DELETE ON internal_order_contexts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_internal_order_actions BEFORE UPDATE OR DELETE ON internal_order_actions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE OR REPLACE FUNCTION guard_internal_order_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof internal_order_actions%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'internal order history is retained' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.status='pending' AND NEW.status='pending' THEN
   SELECT * INTO proof FROM internal_order_actions WHERE owner_id=OLD.owner_id AND order_id=OLD.id
    AND before_revision=OLD.revision AND after_revision=OLD.revision+1;
   IF NOT FOUND OR proof.before_snapshot IS DISTINCT FROM to_jsonb(OLD)
    OR (to_jsonb(NEW)-'quantity'-'limit_price'-'fees'-'reservation_cash'-'note'-'revision') IS DISTINCT FROM
       (to_jsonb(OLD)-'quantity'-'limit_price'-'fees'-'reservation_cash'-'note'-'revision')
    OR NEW.quantity IS DISTINCT FROM (proof.after_snapshot->>'quantity')::numeric
    OR NEW.limit_price IS DISTINCT FROM (proof.after_snapshot->>'limit_price')::numeric
    OR NEW.fees IS DISTINCT FROM (proof.after_snapshot->>'fees')::numeric
    OR NEW.reservation_cash IS DISTINCT FROM (proof.after_snapshot->>'reservation_cash')::numeric
    OR NEW.note IS DISTINCT FROM proof.after_snapshot->>'note' THEN
    RAISE EXCEPTION 'internal amendment requires exact immutable evidence' USING ERRCODE='23514';
   END IF;
  ELSIF OLD.status<>'pending' OR NEW.status<>'cancelled' OR
    (to_jsonb(NEW)-'status'-'revision'-'cancelled_at') IS DISTINCT FROM
    (to_jsonb(OLD)-'status'-'revision'-'cancelled_at') THEN
   RAISE EXCEPTION 'internal order change requires explicit operation' USING ERRCODE='23514';
  END IF;
  NEW.revision:=OLD.revision+1;
 END IF;
 INSERT INTO internal_order_collections(owner_id,revision) VALUES(NEW.owner_id,1)
 ON CONFLICT(owner_id) DO UPDATE SET revision=internal_order_collections.revision+1;
 RETURN NEW;
END $$;
-- Internal intents share the owner UUID namespace with financial and account actions.
ALTER TABLE asset_request_domains DROP CONSTRAINT asset_request_domains_domain_check;
ALTER TABLE asset_request_domains ADD CONSTRAINT asset_request_domains_domain_check
 CHECK(domain IN ('cash','trade','fund','instrument','internal_order','legacy_flat_order','legacy_order_import'));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM internal_order_operations i JOIN asset_request_domains a USING(owner_id,request_id))
 OR EXISTS(SELECT 1 FROM internal_order_operations i JOIN broker_request_domains b USING(owner_id,request_id) WHERE b.domain<>'asset')
 THEN RAISE EXCEPTION 'internal order UUID collision requires explicit reconciliation' USING ERRCODE='23514'; END IF;
END $$;
INSERT INTO asset_request_domains(owner_id,request_id,domain)
 SELECT owner_id,request_id,'internal_order' FROM internal_order_operations;
INSERT INTO broker_request_domains(owner_id,request_id,domain)
 SELECT owner_id,request_id,'asset' FROM internal_order_operations ON CONFLICT(owner_id,request_id) DO NOTHING;
CREATE TRIGGER internal_order_request_domain BEFORE INSERT ON internal_order_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_asset_request_domain('internal_order');
CREATE TRIGGER immutable_internal_order_operations BEFORE UPDATE OR DELETE ON internal_order_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
