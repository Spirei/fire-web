-- Explicit observations never make a broker instruction. Filled status needs a
-- same-transaction immutable canonical child trade, verified at commit.
ALTER TABLE internal_orders ADD COLUMN completed_at timestamptz;
ALTER TABLE internal_orders ADD COLUMN completion_request_id uuid;
ALTER TABLE internal_orders DROP CONSTRAINT internal_orders_status_check;
ALTER TABLE internal_orders ADD CONSTRAINT internal_orders_status_check
 CHECK(status IN ('pending','cancelled','imported_suspended','filled','expired'));
ALTER TABLE internal_orders DROP CONSTRAINT internal_orders_status_time;
ALTER TABLE internal_orders ADD CONSTRAINT internal_orders_status_time CHECK(
 (status IN ('pending','imported_suspended') AND cancelled_at IS NULL AND completed_at IS NULL AND completion_request_id IS NULL) OR
 (status='cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL AND completion_request_id IS NULL) OR
 (status IN ('filled','expired') AND cancelled_at IS NULL AND completed_at IS NOT NULL AND completion_request_id IS NOT NULL));
CREATE TABLE internal_order_observation_previews(
 token_hash text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),session_hash text NOT NULL,
 order_id uuid NOT NULL,fingerprint text NOT NULL,dependencies jsonb NOT NULL,plan jsonb NOT NULL,
 quote_meta jsonb,quote_raw bytea CHECK(octet_length(quote_raw)<=2097152),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '60 seconds',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner_id,order_id) REFERENCES internal_orders(owner_id,id));
CREATE TRIGGER immutable_internal_observation_preview BEFORE UPDATE OR DELETE ON internal_order_observation_previews FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE internal_order_completion_proofs(
 owner_id text NOT NULL,request_id uuid NOT NULL,order_id uuid NOT NULL,
 before_revision bigint NOT NULL,after_revision bigint NOT NULL,
 before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,
 kind text NOT NULL CHECK(kind IN ('actual_fill','simulation','expiry')),
 child_request_id uuid,fill jsonb,quote_meta jsonb,quote_raw bytea CHECK(octet_length(quote_raw)<=2097152),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),UNIQUE(owner_id,order_id,after_revision),
 CHECK(after_revision=before_revision+1),
 CHECK((kind='expiry' AND child_request_id IS NULL AND fill IS NULL) OR
       (kind IN ('actual_fill','simulation') AND child_request_id IS NOT NULL AND jsonb_typeof(fill)='object')),
 FOREIGN KEY(owner_id,order_id) REFERENCES internal_orders(owner_id,id));
CREATE TRIGGER immutable_internal_completion_proof BEFORE UPDATE OR DELETE ON internal_order_completion_proofs FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE OR REPLACE FUNCTION guard_internal_order_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof internal_order_actions%ROWTYPE; completion internal_order_completion_proofs%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'internal order history is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND NEW.status IN ('filled','expired') THEN
  RAISE EXCEPTION 'completed internal orders require retained pending origin' USING ERRCODE='23514';
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
  ELSIF OLD.status='pending' AND NEW.status IN ('filled','expired') THEN
   SELECT * INTO completion FROM internal_order_completion_proofs
    WHERE owner_id=OLD.owner_id AND request_id=NEW.completion_request_id AND order_id=OLD.id
    AND before_revision=OLD.revision AND after_revision=OLD.revision+1;
   IF NOT FOUND OR completion.before_snapshot IS DISTINCT FROM to_jsonb(OLD)
    OR completion.after_snapshot IS DISTINCT FROM (to_jsonb(NEW)||jsonb_build_object('revision',OLD.revision+1))
    OR (to_jsonb(NEW)-'status'-'revision'-'completed_at'-'completion_request_id') IS DISTINCT FROM
       (to_jsonb(OLD)-'status'-'revision'-'completed_at'-'completion_request_id')
    OR (NEW.status='expired') IS DISTINCT FROM (completion.kind='expiry') THEN
    RAISE EXCEPTION 'internal completion requires exact immutable evidence' USING ERRCODE='23514';
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
CREATE FUNCTION verify_internal_order_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o internal_orders%ROWTYPE;t trade_ledger%ROWTYPE;
BEGIN
 SELECT * INTO o FROM internal_orders WHERE owner_id=NEW.owner_id AND id=NEW.order_id;
 IF NOT FOUND OR o.revision<>NEW.after_revision OR o.completion_request_id<>NEW.request_id
   OR to_jsonb(o) IS DISTINCT FROM NEW.after_snapshot THEN
  RAISE EXCEPTION 'completion proof does not match retained order' USING ERRCODE='23514'; END IF;
 IF NEW.kind='expiry' THEN
  IF o.status<>'expired' THEN RAISE EXCEPTION 'expiry cannot claim a fill' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO t FROM trade_ledger WHERE owner_id=NEW.owner_id AND request_id=NEW.child_request_id;
  IF NOT FOUND OR o.status<>'filled' OR t.account_id<>o.account_id OR t.record_id<>o.record_id
   OR t.account_kind<>o.account_kind OR t.side<>o.side OR t.quantity<>o.quantity OR t.currency<>o.currency
   OR t.before_record_revision IS DISTINCT FROM (NEW.fill->>'recordRevision')::bigint
   OR t.price IS DISTINCT FROM (NEW.fill->>'price')::numeric OR t.amount IS DISTINCT FROM (NEW.fill->>'amount')::numeric
   OR t.fees IS DISTINCT FROM (NEW.fill->>'fees')::numeric OR t.settlement_currency IS DISTINCT FROM (NEW.fill->>'settlementCurrency')
   OR t.settlement_amount IS DISTINCT FROM (NEW.fill->>'settlementAmount')::numeric
   OR t.occurred_at IS DISTINCT FROM (NEW.fill->>'occurredAt')::timestamptz
   OR NOT EXISTS(SELECT 1 FROM trade_operations x WHERE x.owner_id=NEW.owner_id AND x.request_id=NEW.child_request_id AND x.result->>'tradeId'=t.id::text AND x.result->>'state'='completed')
   OR (NEW.kind='actual_fill' AND (o.account_kind<>'real' OR (NEW.fill->>'confirmedActualFill') IS DISTINCT FROM 'true'))
   OR (NEW.kind='simulation' AND (o.account_kind<>'simulated' OR NEW.quote_meta IS NULL OR NEW.quote_raw IS NULL
       OR encode(sha256(NEW.quote_raw),'hex') IS DISTINCT FROM (NEW.quote_meta->>'rawSha256')
       OR t.price IS DISTINCT FROM (NEW.quote_meta->>'priceExact')::numeric
       OR t.currency IS DISTINCT FROM (NEW.quote_meta->>'currency')
       OR t.occurred_at IS DISTINCT FROM (NEW.quote_meta->>'at')::timestamptz
       OR (NEW.quote_meta->'cached'='false'::jsonb OR
          (NEW.quote_meta->'cached'='null'::jsonb AND NEW.quote_meta->>'witness'='source_rt_observed_point')) IS NOT TRUE)) THEN
   RAISE EXCEPTION 'completed internal order lacks exact canonical child fill' USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM internal_order_operations r WHERE r.owner_id=NEW.owner_id AND r.request_id=NEW.request_id)
 THEN RAISE EXCEPTION 'completion requires original parent receipt' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER internal_order_completion_verified AFTER INSERT ON internal_order_completion_proofs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_internal_order_completion();
