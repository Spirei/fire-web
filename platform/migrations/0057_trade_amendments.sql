-- Immutable original trades plus append-only owner ledger amendments.
CREATE TABLE trade_amendments (
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,request_id uuid NOT NULL,record_id text NOT NULL,trade_id uuid NOT NULL,
 replacement_id uuid NOT NULL,previous_amendment_id uuid,previous_record_amendment_id uuid,
 before_record_revision bigint NOT NULL,trade_tip_id uuid NOT NULL,fee_projection_id uuid,
 before_quantity numeric NOT NULL,after_quantity numeric NOT NULL,before_cost numeric,after_cost numeric,
 before_realized numeric,after_realized numeric,currency text NOT NULL,cash_delta numeric NOT NULL,
 before_event jsonb NOT NULL,replacement jsonb NOT NULL,evidence jsonb NOT NULL,evidence_raw bytea NOT NULL,evidence_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id),UNIQUE(replacement_id),
 FOREIGN KEY(owner_id,request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,previous_amendment_id) REFERENCES trade_amendments(owner_id,id),
 FOREIGN KEY(owner_id,previous_record_amendment_id) REFERENCES trade_amendments(owner_id,id),
 CHECK(before_record_revision>0 AND before_quantity>=0 AND after_quantity>=0),
 CHECK(evidence=convert_from(evidence_raw,'UTF8')::jsonb AND evidence_sha256=encode(sha256(evidence_raw),'hex'))
);
ALTER TABLE portfolio_records ADD COLUMN amendment_tip_id uuid;
ALTER TABLE portfolio_records ADD FOREIGN KEY(owner_id,amendment_tip_id) REFERENCES trade_amendments(owner_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cash_ledger_entries ADD COLUMN trade_amendment_id uuid;
ALTER TABLE cash_ledger_entries ADD FOREIGN KEY(owner_id,trade_amendment_id) REFERENCES trade_amendments(owner_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cash_ledger_entries DROP CONSTRAINT cash_ledger_entries_kind_check;
ALTER TABLE cash_ledger_entries ADD CHECK(kind IN ('opening','external_deposit','external_withdrawal','reconcile_balance','allocation','trade_buy','trade_sell','trade_dividend','fee_correction','trade_correction'));
ALTER TABLE cash_ledger_entries DROP CONSTRAINT cash_posting_sign;
ALTER TABLE cash_ledger_entries ADD CONSTRAINT cash_posting_sign CHECK((kind IN ('opening','external_deposit','allocation') AND amount>=0) OR (kind IN ('external_withdrawal','trade_buy','fee_correction') AND amount<=0) OR kind IN ('reconcile_balance','trade_sell','trade_dividend','trade_correction'));
ALTER TABLE cash_ledger_entries ADD CHECK((kind='trade_correction')=(trade_amendment_id IS NOT NULL));
CREATE FUNCTION current_effective_trade_event(owner_arg text,trade_arg uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE result jsonb;
BEGIN
 SELECT replacement INTO result FROM trade_amendments WHERE owner_id=owner_arg AND trade_id=trade_arg ORDER BY before_record_revision DESC LIMIT 1;
 IF FOUND THEN RETURN result; END IF;
 SELECT jsonb_build_object('id',t.id,'side',t.side,'quantity',t.quantity::text,'price',t.price::text,'amount',t.amount::text,
  'fees',coalesce(c.new_fees,t.fees)::text,'currency',t.currency,'settlement_currency',t.settlement_currency,
  'settlement_amount',t.settlement_amount::text,'occurred_at',t.occurred_at,'created_at',t.created_at)
 INTO result FROM trade_ledger t LEFT JOIN trade_fee_corrections c ON c.owner_id=t.owner_id AND c.trade_id=t.id
 WHERE t.owner_id=owner_arg AND t.id=trade_arg;
 RETURN result;
END $$;
CREATE FUNCTION amendable_native_registration(owner_arg text,trade_arg uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM trade_ledger t JOIN trade_operations o ON o.owner_id=t.owner_id AND o.request_id=t.request_id
 JOIN cash_ledger_entries e ON e.owner_id=t.owner_id AND e.id=t.cash_entry_id AND e.source_trade_id=t.id
 JOIN broker_accounts a ON a.owner_id=t.owner_id AND a.id=t.account_id
 WHERE t.owner_id=owner_arg AND t.id=trade_arg AND t.source='owner_recorded' AND t.side IN ('buy','sell')
 AND a.holding_source='manual' AND t.currency=t.settlement_currency AND t.settlement_amount IS NULL
 AND o.result->>'state'='completed' AND o.result->>'tradeId'=t.id::text AND o.result->>'source'='owner_recorded' AND o.result->>'brokerExecution'='false'
 AND o.result->>'cashEntryId'=e.id::text AND o.result->>'accountId'=t.account_id AND o.result->>'recordId'=t.record_id
 AND e.account_id=t.account_id AND e.account_kind=t.account_kind AND e.currency=t.currency AND e.amount=t.cash_delta AND e.request_id=t.request_id AND e.kind='trade_'||t.side AND e.affects_owner
 AND NOT EXISTS(SELECT 1 FROM financial_import_links l WHERE l.owner_id=t.owner_id AND ((l.object_kind='order' AND l.target_id=t.id::text) OR (l.object_kind='cash' AND l.target_id=e.id::text)))
 AND NOT EXISTS(SELECT 1 FROM trade_fee_import_evidence b WHERE b.owner_id=t.owner_id AND b.trade_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM legacy_fee_baseline_bindings b WHERE b.owner_id=t.owner_id AND b.trade_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM fee_legacy_inventory_orders b WHERE b.owner_id=t.owner_id AND b.trade_id=t.id))
$$;
CREATE FUNCTION guard_trade_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original trade_ledger;record portfolio_records;previous uuid;fee jsonb;receipt jsonb;native_actual boolean;
BEGIN
 SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
 SELECT * INTO record FROM portfolio_records WHERE owner_id=NEW.owner_id AND id=NEW.record_id FOR UPDATE;
 SELECT id INTO previous FROM trade_amendments WHERE owner_id=NEW.owner_id AND trade_id=NEW.trade_id ORDER BY before_record_revision DESC LIMIT 1;
 SELECT detail INTO fee FROM trade_fee_details WHERE owner_id=NEW.owner_id AND trade_id=NEW.trade_id;
 SELECT result INTO receipt FROM trade_operations WHERE owner_id=NEW.owner_id AND request_id=original.request_id;
 IF NOT amendable_native_registration(NEW.owner_id,NEW.trade_id) OR original.id IS NULL OR original.record_id<>NEW.record_id OR original.source<>'owner_recorded' OR original.side NOT IN ('buy','sell')
 OR original.currency<>NEW.currency OR original.currency<>original.settlement_currency OR original.settlement_amount IS NOT NULL
 OR receipt->>'state' IS DISTINCT FROM 'completed' OR receipt->>'tradeId' IS DISTINCT FROM NEW.trade_id::text
 OR receipt->>'source' IS DISTINCT FROM 'owner_recorded' OR receipt->>'brokerExecution' IS DISTINCT FROM 'false'
 OR NOT EXISTS(SELECT 1 FROM broker_accounts a WHERE a.owner_id=NEW.owner_id AND a.id=original.account_id AND a.holding_source='manual')
 OR EXISTS(SELECT 1 FROM financial_import_links l WHERE l.owner_id=NEW.owner_id AND ((l.object_kind='order' AND l.target_id=NEW.trade_id::text) OR (l.object_kind='cash' AND l.target_id=original.cash_entry_id::text)))
 OR record.revision<>NEW.before_record_revision OR record.trade_tip_id<>NEW.trade_tip_id OR record.fee_projection_id IS DISTINCT FROM NEW.fee_projection_id
 OR record.qty IS DISTINCT FROM NEW.before_quantity OR record.cost IS DISTINCT FROM NEW.before_cost
 OR record.amendment_tip_id IS DISTINCT FROM NEW.previous_record_amendment_id OR previous IS DISTINCT FROM NEW.previous_amendment_id
 OR NEW.before_event IS DISTINCT FROM current_effective_trade_event(NEW.owner_id,NEW.trade_id)
 THEN RAISE EXCEPTION 'trade amendment requires exact immutable native owner registration, current original event and record CAS chain' USING ERRCODE='23514'; END IF;
 IF fee->>'source'='rule_calculated' THEN
  SELECT EXISTS(SELECT 1 FROM native_actual_fee_confirmations a JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.new_fees=a.actual_fee WHERE a.owner_id=NEW.owner_id AND a.trade_id=NEW.trade_id) INTO native_actual;
  IF NOT native_actual THEN RAISE EXCEPTION 'calculated fees need independent actual confirmation before a ledger amendment' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.replacement->>'quantity' IS NULL OR NEW.replacement->>'price' IS NULL OR NEW.replacement->>'fees' IS NULL OR NEW.replacement->>'amount' IS NULL OR NEW.replacement->>'occurred_at' IS NULL
 OR (NEW.replacement->>'quantity')::numeric>1e12 OR (NEW.replacement->>'price')::numeric>1e12 OR (NEW.replacement->>'fees')::numeric>1e12 OR (NEW.replacement->>'amount')::numeric>1e12
 OR scale((NEW.replacement->>'quantity')::numeric)>8 OR scale((NEW.replacement->>'price')::numeric)>8 OR scale((NEW.replacement->>'fees')::numeric)>8
 OR NEW.cash_delta IS DISTINCT FROM (CASE original.side WHEN 'buy' THEN -(NEW.replacement->>'amount')::numeric-(NEW.replacement->>'fees')::numeric ELSE (NEW.replacement->>'amount')::numeric-(NEW.replacement->>'fees')::numeric END)-(CASE original.side WHEN 'buy' THEN -(NEW.before_event->>'amount')::numeric-(NEW.before_event->>'fees')::numeric ELSE (NEW.before_event->>'amount')::numeric-(NEW.before_event->>'fees')::numeric END)
 OR NEW.after_quantity IS DISTINCT FROM NEW.before_quantity+((NEW.replacement->>'quantity')::numeric-(NEW.before_event->>'quantity')::numeric)*(CASE original.side WHEN 'buy' THEN 1 ELSE -1 END)
 OR NEW.evidence->'beforeEvent' IS DISTINCT FROM NEW.before_event OR NEW.evidence->'replacement' IS DISTINCT FROM NEW.replacement
 OR NEW.evidence->>'originalRegistrationRequestId' IS DISTINCT FROM original.request_id::text
 OR NEW.evidence->>'brokerAccountId' IS DISTINCT FROM original.account_id OR NEW.evidence->>'currency' IS DISTINCT FROM NEW.currency
 THEN RAISE EXCEPTION 'amendment evidence must bind its exact bounded replacement, original event and conserved delta' USING ERRCODE='23514'; END IF;
 IF NEW.replacement->>'id' IS DISTINCT FROM NEW.trade_id::text OR NEW.replacement->>'side' IS DISTINCT FROM original.side
 OR NEW.replacement->>'currency' IS DISTINCT FROM NEW.currency OR NEW.replacement->>'settlement_currency' IS DISTINCT FROM NEW.currency
 OR NEW.replacement->'settlement_amount' IS DISTINCT FROM 'null'::jsonb OR NEW.replacement->>'created_at' IS DISTINCT FROM NEW.before_event->>'created_at'
 OR (NEW.replacement->>'quantity')::numeric<=0 OR (NEW.replacement->>'price')::numeric<0 OR (NEW.replacement->>'fees')::numeric<0
 OR (NEW.replacement->>'amount')::numeric IS DISTINCT FROM (NEW.replacement->>'quantity')::numeric*(NEW.replacement->>'price')::numeric
 OR NEW.evidence->>'kind' IS DISTINCT FROM 'owner_statement' OR NEW.evidence->>'authority' IS DISTINCT FROM 'owner_recorded'
 OR NEW.evidence->>'actualPaidConfirmed' IS DISTINCT FROM 'true' OR NEW.evidence->>'ledgerCorrectionConfirmed' IS DISTINCT FROM 'true'
 OR NEW.evidence->>'targetUserId' IS DISTINCT FROM NEW.owner_id OR NEW.evidence->>'tradeId' IS DISTINCT FROM NEW.trade_id::text
 OR NEW.evidence->>'statement' IS NULL OR length(btrim(NEW.evidence->>'statement')) NOT BETWEEN 1 AND 4096
 THEN RAISE EXCEPTION 'amendment replacement requires precise same-side actual owner evidence, never a broker order' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_trade_amendment BEFORE INSERT ON trade_amendments FOR EACH ROW EXECUTE FUNCTION guard_trade_amendment();
CREATE TRIGGER immutable_trade_amendment BEFORE UPDATE OR DELETE ON trade_amendments FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION check_trade_amendment_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id
  AND o.result->>'state'='completed' AND o.result->>'kind'='trade_amendment' AND o.result->>'amendmentId'=NEW.id::text)
 OR NOT EXISTS(SELECT 1 FROM cash_ledger_entries e JOIN trade_ledger t ON t.owner_id=e.owner_id AND t.id=NEW.trade_id
  WHERE e.owner_id=NEW.owner_id AND e.request_id=NEW.request_id AND e.trade_amendment_id=NEW.id AND e.kind='trade_correction'
  AND e.account_id=t.account_id AND e.account_kind=t.account_kind AND e.currency=NEW.currency AND e.amount=NEW.cash_delta AND e.affects_owner)
 OR NOT EXISTS(SELECT 1 FROM portfolio_records r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.record_id
  AND r.amendment_tip_id=NEW.id AND r.revision=NEW.before_record_revision+1 AND r.qty IS NOT DISTINCT FROM NEW.after_quantity AND r.cost IS NOT DISTINCT FROM NEW.after_cost)
 THEN RAISE EXCEPTION 'trade amendment requires exact same original UUID atomic cash position and final receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_trade_amendment_posting AFTER INSERT ON trade_amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_trade_amendment_posting();
CREATE FUNCTION check_trade_amendment_cash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='trade_correction' AND NOT EXISTS(SELECT 1 FROM trade_amendments a WHERE a.owner_id=NEW.owner_id AND a.id=NEW.trade_amendment_id AND a.request_id=NEW.request_id AND a.cash_delta=NEW.amount AND a.currency=NEW.currency)
 THEN RAISE EXCEPTION 'trade correction cash requires its immutable same-UUID amendment' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_trade_amendment_cash AFTER INSERT ON cash_ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_trade_amendment_cash();

CREATE OR REPLACE FUNCTION guard_portfolio_trade_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fill trade_ledger;
DECLARE projection trade_fee_projections;
DECLARE amendment trade_amendments;
BEGIN
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
