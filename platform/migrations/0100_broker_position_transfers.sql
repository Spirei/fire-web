-- Owner-confirmed full-position transfers are paired evidence, never synthetic trades.
CREATE TABLE broker_position_transfer_previews (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL, request_id uuid NOT NULL,
 payload jsonb NOT NULL, plan jsonb NOT NULL, payload_hash text NOT NULL, plan_hash text NOT NULL,
 authorization_binding text NOT NULL, record_collection_revision bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 PRIMARY KEY(owner_id,id)
);
CREATE TRIGGER broker_transfer_preview_no_rewrite BEFORE UPDATE ON broker_position_transfer_previews FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE broker_position_transfer_operations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL, request_hash text, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER broker_transfer_operation_no_rewrite BEFORE UPDATE OR DELETE ON broker_position_transfer_operations FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE broker_position_transfers (
 owner_id text NOT NULL, id uuid NOT NULL, request_id uuid NOT NULL,
 source_record_id text NOT NULL, target_record_id text NOT NULL,
 source_account_id text NOT NULL, target_account_id text NOT NULL,
 account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
 quantity numeric NOT NULL CHECK(quantity>0 AND quantity<1e30), unit_cost numeric NOT NULL CHECK(unit_cost>-1e30 AND unit_cost<1e30),
 source_account_revision bigint NOT NULL, target_account_revision bigint NOT NULL,
 source_snapshot jsonb NOT NULL, evidence jsonb NOT NULL, evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 authorization_binding text NOT NULL, occurred_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,id), UNIQUE(owner_id,request_id),
 CHECK(source_record_id<>target_record_id AND source_account_id<>target_account_id),
 FOREIGN KEY(owner_id,source_record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,target_record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,source_account_id) REFERENCES broker_accounts(owner_id,id),
 FOREIGN KEY(owner_id,target_account_id) REFERENCES broker_accounts(owner_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES broker_position_transfer_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER broker_transfer_no_rewrite BEFORE UPDATE OR DELETE ON broker_position_transfers FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE broker_position_transfer_events (
 owner_id text NOT NULL, id uuid NOT NULL, transfer_id uuid NOT NULL, record_id text NOT NULL, account_id text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('out','in')), before_record_revision bigint NOT NULL,
 before_quantity numeric NOT NULL, before_cost numeric NOT NULL, after_quantity numeric NOT NULL, after_cost numeric NOT NULL,
 previous_transfer_id uuid, before_snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,transfer_id,direction),
 FOREIGN KEY(owner_id,transfer_id) REFERENCES broker_position_transfers(owner_id,id),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id),
 FOREIGN KEY(owner_id,previous_transfer_id) REFERENCES broker_position_transfer_events(owner_id,id)
);
CREATE TRIGGER broker_transfer_event_no_rewrite BEFORE UPDATE OR DELETE ON broker_position_transfer_events FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
ALTER TABLE portfolio_records ADD COLUMN position_transfer_id uuid;
ALTER TABLE portfolio_records ADD FOREIGN KEY(owner_id,position_transfer_id) REFERENCES broker_position_transfer_events(owner_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION check_broker_transfer_pointer_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.position_transfer_id IS NOT NULL THEN
  RAISE EXCEPTION 'transfer checkpoint must be applied to its exact prior record' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broker_transfer_pointer_insert BEFORE INSERT ON portfolio_records FOR EACH ROW EXECUTE FUNCTION check_broker_transfer_pointer_insert();
CREATE FUNCTION check_broker_transfer_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p portfolio_records; h broker_position_transfers; a broker_accounts; b broker_accounts;
BEGIN
 SELECT * INTO p FROM portfolio_records WHERE owner_id=NEW.owner_id AND id=NEW.record_id FOR UPDATE;
 SELECT * INTO h FROM broker_position_transfers WHERE owner_id=NEW.owner_id AND id=NEW.transfer_id;
 SELECT * INTO a FROM broker_accounts WHERE owner_id=h.owner_id AND id=h.source_account_id;
 SELECT * INTO b FROM broker_accounts WHERE owner_id=h.owner_id AND id=h.target_account_id;
 IF p.id IS NULL OR h.id IS NULL OR p.deleted_at IS NOT NULL OR a.deleted_at IS NOT NULL OR b.deleted_at IS NOT NULL
 OR a.account_kind<>h.account_kind OR b.account_kind<>h.account_kind OR a.holding_source<>'manual' OR b.holding_source<>'manual'
 OR a.revision<>h.source_account_revision OR b.revision<>h.target_account_revision
 OR EXISTS(SELECT 1 FROM internal_orders WHERE owner_id=NEW.owner_id AND record_id=h.source_record_id AND status='pending')
 OR p.revision<>NEW.before_record_revision OR p.qty IS DISTINCT FROM NEW.before_quantity OR p.cost IS DISTINCT FROM NEW.before_cost
 OR p.broker_account_id IS DISTINCT FROM NEW.account_id OR to_jsonb(p) IS DISTINCT FROM NEW.before_snapshot
 OR p.position_transfer_id IS DISTINCT FROM NEW.previous_transfer_id
 OR (NEW.direction='out' AND (NEW.record_id<>h.source_record_id OR NEW.account_id<>h.source_account_id
     OR NEW.before_quantity<>h.quantity OR NEW.before_cost<>h.unit_cost OR NEW.after_quantity<>0 OR NEW.after_cost<>0
     OR NEW.before_snapshot IS DISTINCT FROM h.source_snapshot))
 OR (NEW.direction='in' AND (NEW.record_id<>h.target_record_id OR NEW.account_id<>h.target_account_id
     OR NEW.before_quantity<>0 OR NEW.before_cost<>0 OR NEW.after_quantity<>h.quantity OR NEW.after_cost<>h.unit_cost
     OR p.trade_tip_id IS NOT NULL OR p.amendment_tip_id IS NOT NULL OR p.fee_projection_id IS NOT NULL OR p.history_state<>'empty'
     OR p.source<>'owner_transfer'))
 THEN RAISE EXCEPTION 'transfer event requires exact owned source and fresh destination' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broker_transfer_event_check BEFORE INSERT ON broker_position_transfer_events FOR EACH ROW EXECUTE FUNCTION check_broker_transfer_event();
CREATE FUNCTION check_broker_transfer_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE outgoing broker_position_transfer_events; incoming broker_position_transfer_events; s portfolio_records; t portfolio_records;
BEGIN
 SELECT * INTO outgoing FROM broker_position_transfer_events WHERE owner_id=NEW.owner_id AND transfer_id=NEW.id AND direction='out';
 SELECT * INTO incoming FROM broker_position_transfer_events WHERE owner_id=NEW.owner_id AND transfer_id=NEW.id AND direction='in';
 SELECT * INTO s FROM portfolio_records WHERE owner_id=NEW.owner_id AND id=NEW.source_record_id;
 SELECT * INTO t FROM portfolio_records WHERE owner_id=NEW.owner_id AND id=NEW.target_record_id;
 IF outgoing.id IS NULL OR incoming.id IS NULL OR s.position_transfer_id IS DISTINCT FROM outgoing.id OR t.position_transfer_id IS DISTINCT FROM incoming.id
 OR s.qty IS DISTINCT FROM 0::numeric OR s.cost IS DISTINCT FROM 0::numeric OR t.qty IS DISTINCT FROM NEW.quantity OR t.cost IS DISTINCT FROM NEW.unit_cost
 OR s.code<>t.code OR s.market<>t.market OR s.account_market<>t.account_market
 THEN RAISE EXCEPTION 'transfer must commit an exact balanced out/in pair' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER broker_transfer_pair AFTER INSERT ON broker_position_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_broker_transfer_pair();

-- Preserve every existing fill/fee/amendment branch; only exact transfer checkpoints add authority.
CREATE OR REPLACE FUNCTION guard_portfolio_trade_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fill trade_ledger;
DECLARE projection trade_fee_projections;
DECLARE amendment trade_amendments;
DECLARE transfer_event broker_position_transfer_events;
BEGIN
    IF NEW.position_transfer_id IS DISTINCT FROM OLD.position_transfer_id THEN
        SELECT * INTO transfer_event FROM broker_position_transfer_events WHERE owner_id=OLD.owner_id AND id=NEW.position_transfer_id;
        IF NOT FOUND OR transfer_event.record_id<>OLD.id OR transfer_event.account_id IS DISTINCT FROM OLD.broker_account_id
        OR transfer_event.before_record_revision<>OLD.revision OR transfer_event.before_snapshot IS DISTINCT FROM to_jsonb(OLD)
        OR transfer_event.previous_transfer_id IS DISTINCT FROM OLD.position_transfer_id
        OR transfer_event.after_quantity IS DISTINCT FROM NEW.qty OR transfer_event.after_cost IS DISTINCT FROM NEW.cost
        OR NEW.revision<>OLD.revision+1
        OR (to_jsonb(NEW)-ARRAY['qty','cost','position_transfer_id','revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['qty','cost','position_transfer_id','revision','updated_at'])
        THEN RAISE EXCEPTION 'position transfer requires exact append-only checkpoint' USING ERRCODE='23514'; END IF;
        RETURN NEW;
    END IF;
    IF OLD.position_transfer_id IS NOT NULL AND
       (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.code<>OLD.code OR NEW.market<>OLD.market
        OR NEW.account_market<>OLD.account_market OR NEW.broker_account_id IS DISTINCT FROM OLD.broker_account_id OR NEW.source<>OLD.source) THEN
        RAISE EXCEPTION 'transferred position identity and evidence are retained' USING ERRCODE='23514';
    END IF;
    IF OLD.position_transfer_id IS NOT NULL
       AND NEW.trade_tip_id IS NOT DISTINCT FROM OLD.trade_tip_id
       AND NEW.fee_projection_id IS NOT DISTINCT FROM OLD.fee_projection_id
       AND NEW.amendment_tip_id IS NOT DISTINCT FROM OLD.amendment_tip_id
       AND (NEW.qty IS DISTINCT FROM OLD.qty OR NEW.cost IS DISTINCT FROM OLD.cost) THEN
        RAISE EXCEPTION 'transferred economics require an evidenced checkpoint or fill' USING ERRCODE='23514';
    END IF;
    IF NEW.amendment_tip_id IS DISTINCT FROM OLD.amendment_tip_id THEN
        SELECT * INTO amendment FROM trade_amendments WHERE owner_id=OLD.owner_id AND id=NEW.amendment_tip_id;
        IF NOT FOUND OR amendment.record_id<>OLD.id OR amendment.before_record_revision<>OLD.revision
        OR amendment.previous_record_amendment_id IS DISTINCT FROM OLD.amendment_tip_id
        OR amendment.trade_tip_id IS DISTINCT FROM OLD.trade_tip_id OR NEW.trade_tip_id IS DISTINCT FROM OLD.trade_tip_id
        OR NEW.fee_projection_id IS DISTINCT FROM OLD.fee_projection_id OR amendment.fee_projection_id IS DISTINCT FROM OLD.fee_projection_id
        OR amendment.before_quantity IS DISTINCT FROM OLD.qty OR amendment.after_quantity IS DISTINCT FROM NEW.qty
        OR amendment.before_cost IS DISTINCT FROM OLD.cost OR amendment.after_cost IS DISTINCT FROM NEW.cost
        OR NEW.revision<>OLD.revision+1 OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
        THEN RAISE EXCEPTION 'amended position requires its exact append-only ledger chain' USING ERRCODE='23514'; END IF;
    ELSIF NEW.fee_projection_id IS DISTINCT FROM OLD.fee_projection_id THEN
        SELECT * INTO projection FROM trade_fee_projections WHERE owner_id=OLD.owner_id AND id=NEW.fee_projection_id;
        IF NOT FOUND OR projection.record_id<>OLD.id OR projection.before_record_revision<>OLD.revision OR projection.previous_projection_id IS DISTINCT FROM OLD.fee_projection_id OR projection.trade_tip_id IS DISTINCT FROM OLD.trade_tip_id OR NEW.trade_tip_id IS DISTINCT FROM OLD.trade_tip_id OR projection.quantity IS DISTINCT FROM OLD.qty OR NEW.qty IS DISTINCT FROM OLD.qty OR projection.before_cost IS DISTINCT FROM OLD.cost OR projection.after_cost IS DISTINCT FROM NEW.cost OR NEW.revision<>OLD.revision+1 OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
            RAISE EXCEPTION 'fee projection requires exact append-only evidence' USING ERRCODE='23514';
        END IF;
    ELSIF NEW.trade_tip_id IS DISTINCT FROM OLD.trade_tip_id THEN
        SELECT * INTO fill FROM trade_ledger WHERE owner_id=OLD.owner_id AND id=NEW.trade_tip_id;
        IF NOT FOUND OR fill.record_id<>OLD.id OR fill.account_id IS DISTINCT FROM OLD.broker_account_id
           OR fill.before_record_revision<>OLD.revision OR fill.previous_trade_id IS DISTINCT FROM OLD.trade_tip_id
           OR fill.before_quantity IS DISTINCT FROM OLD.qty OR fill.before_cost IS DISTINCT FROM OLD.cost
           OR fill.after_quantity IS DISTINCT FROM NEW.qty OR fill.after_cost IS DISTINCT FROM NEW.cost
           OR NEW.history_state<>'has_trades' OR NEW.deleted_at IS NOT NULL THEN
           RAISE EXCEPTION 'position projection requires its exact confirmed fill' USING ERRCODE='23514';
        END IF;
    ELSIF OLD.history_state='has_trades' AND
       (NEW.qty IS DISTINCT FROM OLD.qty OR NEW.cost IS DISTINCT FROM OLD.cost OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
        RAISE EXCEPTION 'position with fills requires trade correction' USING ERRCODE='23514';
    END IF;
    IF (OLD.history_state='has_trades' OR NEW.trade_tip_id IS DISTINCT FROM OLD.trade_tip_id) AND
       (NEW.code<>OLD.code OR NEW.market<>OLD.market OR NEW.account_market<>OLD.account_market
       OR NEW.broker_account_id IS DISTINCT FROM OLD.broker_account_id OR NEW.source<>OLD.source) THEN
        RAISE EXCEPTION 'filled position identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
