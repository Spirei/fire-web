-- Candidate only: additions to the existing trade/cash authority, never replacements.
ALTER TABLE trade_ledger DROP CONSTRAINT trade_ledger_source_check;
ALTER TABLE trade_ledger ADD CHECK(source IN ('owner_recorded','legacy_import_zero','unverified_legacy','broker_reported'));
CREATE TABLE trade_fee_import_evidence(owner_id text NOT NULL,trade_id uuid NOT NULL,input_fingerprint text NOT NULL,detail jsonb NOT NULL,PRIMARY KEY(owner_id,trade_id),FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id));
CREATE TABLE trade_fee_corrections(id uuid PRIMARY KEY,owner_id text NOT NULL,trade_id uuid NOT NULL,request_id uuid NOT NULL,old_fees numeric NOT NULL,new_fees numeric NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(owner_id,trade_id),FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),FOREIGN KEY(owner_id,request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,CHECK(old_fees=0 AND new_fees>=0 AND new_fees<'Infinity'::numeric));
CREATE TABLE trade_fee_projections(id uuid PRIMARY KEY,owner_id text NOT NULL,record_id text NOT NULL,request_id uuid NOT NULL,before_record_revision bigint NOT NULL,previous_projection_id uuid,trade_tip_id uuid NOT NULL,quantity numeric NOT NULL,before_cost numeric,after_cost numeric,before_realized numeric,after_realized numeric,UNIQUE(owner_id,id),FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id),FOREIGN KEY(owner_id,request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED);
ALTER TABLE portfolio_records ADD COLUMN fee_projection_id uuid;
ALTER TABLE portfolio_records ADD FOREIGN KEY(owner_id,fee_projection_id) REFERENCES trade_fee_projections(owner_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE trade_fee_previews(token_hash text PRIMARY KEY,owner_id text NOT NULL,session_hash text NOT NULL,payload_hash text NOT NULL,snapshot_hash text NOT NULL,expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',consumed_at timestamptz);
CREATE TRIGGER fee_evidence_immutable BEFORE UPDATE OR DELETE ON trade_fee_import_evidence FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER fee_corrections_immutable BEFORE UPDATE OR DELETE ON trade_fee_corrections FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER fee_projections_immutable BEFORE UPDATE OR DELETE ON trade_fee_projections FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
ALTER TABLE cash_ledger_entries ADD COLUMN fee_repair_request_id uuid;
ALTER TABLE cash_ledger_entries ADD FOREIGN KEY(owner_id,fee_repair_request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cash_ledger_entries DROP CONSTRAINT cash_ledger_entries_kind_check;
ALTER TABLE cash_ledger_entries ADD CHECK(kind IN ('opening','external_deposit','external_withdrawal','reconcile_balance','allocation','trade_buy','trade_sell','trade_dividend','fee_correction'));
ALTER TABLE cash_ledger_entries DROP CONSTRAINT cash_posting_sign;
ALTER TABLE cash_ledger_entries ADD CONSTRAINT cash_posting_sign CHECK((kind IN ('opening','external_deposit','allocation') AND amount>=0) OR (kind IN ('external_withdrawal','trade_buy','fee_correction') AND amount<=0) OR kind IN ('reconcile_balance','trade_sell','trade_dividend'));
ALTER TABLE cash_ledger_entries ADD CHECK((kind='fee_correction')=(fee_repair_request_id IS NOT NULL));

CREATE OR REPLACE FUNCTION guard_portfolio_trade_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fill trade_ledger;
DECLARE projection trade_fee_projections;
BEGIN
    IF NEW.fee_projection_id IS DISTINCT FROM OLD.fee_projection_id THEN
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
CREATE FUNCTION check_fee_repair_cash() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric;
BEGIN
    IF NEW.kind<>'fee_correction' THEN RETURN NEW; END IF;
    SELECT -sum(new_fees-old_fees) INTO expected FROM trade_fee_corrections WHERE owner_id=NEW.owner_id AND request_id=NEW.fee_repair_request_id;
    IF expected IS NULL OR NEW.amount<>expected OR NEW.request_id<>NEW.fee_repair_request_id OR NOT NEW.affects_owner OR EXISTS(SELECT 1 FROM trade_fee_corrections c JOIN trade_ledger t ON t.owner_id=c.owner_id AND t.id=c.trade_id WHERE c.owner_id=NEW.owner_id AND c.request_id=NEW.fee_repair_request_id AND (t.account_id<>NEW.account_id OR t.account_kind<>NEW.account_kind OR t.currency<>NEW.currency OR t.settlement_currency<>NEW.currency)) THEN
        RAISE EXCEPTION 'fee correction requires exact original cash attribution' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_fee_repair_cash AFTER INSERT ON cash_ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_fee_repair_cash();
CREATE FUNCTION check_fee_repair_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original trade_ledger;
BEGIN
    SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
    IF NOT FOUND OR original.fees<>NEW.old_fees OR original.source NOT IN ('legacy_import_zero','unverified_legacy') OR original.side NOT IN ('buy','sell') THEN
        RAISE EXCEPTION 'explicit actual fees are protected' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=NEW.owner_id AND e.fee_repair_request_id=NEW.request_id AND e.kind='fee_correction') OR NOT EXISTS(SELECT 1 FROM trade_fee_projections p WHERE p.owner_id=NEW.owner_id AND p.request_id=NEW.request_id AND p.record_id=original.record_id) THEN
        RAISE EXCEPTION 'fee correction requires cash and position projection' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_fee_repair_source AFTER INSERT ON trade_fee_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_fee_repair_source();
CREATE TABLE trade_fee_details(owner_id text NOT NULL,trade_id uuid NOT NULL,detail jsonb NOT NULL,PRIMARY KEY(owner_id,trade_id),FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id));
CREATE TRIGGER trade_fee_detail_immutable BEFORE UPDATE OR DELETE ON trade_fee_details FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE fee_rate_windows(owner_id text NOT NULL,minute timestamptz NOT NULL,count int NOT NULL,PRIMARY KEY(owner_id,minute));
