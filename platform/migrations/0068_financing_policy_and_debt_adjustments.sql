-- The policy contract includes all15 currencies, including independent CHF cash.
DO $$ DECLARE constraint_arg text;count_arg integer;
BEGIN
 SELECT count(*),min(conname) INTO count_arg,constraint_arg FROM pg_constraint WHERE conrelid='broker_accounts'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%cardinality(currencies)%';
 IF count_arg<>1 THEN RAISE EXCEPTION 'expected exact existing broker currency membership constraint'; END IF;
 EXECUTE format('ALTER TABLE broker_accounts DROP CONSTRAINT %I',constraint_arg);
END $$;
ALTER TABLE broker_accounts ADD CONSTRAINT broker_accounts_currencies_check CHECK(cardinality(currencies) BETWEEN 1 AND 15 AND currency=ANY(currencies));
CREATE TABLE financing_rate_windows(owner_id text NOT NULL REFERENCES users(id),minute timestamptz NOT NULL,count integer NOT NULL CHECK(count>0),PRIMARY KEY(owner_id,minute));
-- Owner/kind policy metadata and immutable evidence on the existing signed cash ledger.
CREATE TABLE financing_policy_versions (
 owner_id text NOT NULL REFERENCES users(id),account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
 request_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),previous_id uuid,
 policy jsonb NOT NULL,policy_raw bytea NOT NULL,policy_sha256 text NOT NULL,snapshot_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),UNIQUE(owner_id,account_kind,revision),
 FOREIGN KEY(owner_id,request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,previous_id) REFERENCES financing_policy_versions(owner_id,request_id),
 CHECK(policy=convert_from(policy_raw,'UTF8')::jsonb AND policy_sha256=encode(sha256(policy_raw),'hex'))
);
CREATE TABLE financing_policy_heads (
 owner_id text NOT NULL REFERENCES users(id),account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
 request_id uuid NOT NULL,revision bigint NOT NULL,PRIMARY KEY(owner_id,account_kind),
 FOREIGN KEY(owner_id,request_id) REFERENCES financing_policy_versions(owner_id,request_id)
);
CREATE FUNCTION guard_financing_policy_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous financing_policy_heads;item text;
BEGIN
 SELECT * INTO previous FROM financing_policy_heads WHERE owner_id=NEW.owner_id AND account_kind=NEW.account_kind FOR UPDATE;
 IF NEW.revision<>coalesce(previous.revision,0)+1 OR NEW.previous_id IS DISTINCT FROM previous.request_id
 OR NEW.policy->>'currency' NOT IN ('USD','EUR','HKD','MOP','CNY','JPY','KRW','SGD','GBP','AUD','CAD','TWD','CHF','INR','BRL')
 OR NEW.policy->>'currency' IS NULL OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.policy) key) IS DISTINCT FROM ARRAY['currency','initialMargin','limit','maintenanceMargin']::text[]
 THEN RAISE EXCEPTION 'financing policy needs an exact owner-kind predecessor and supported declared currency' USING ERRCODE='23514'; END IF;
 FOREACH item IN ARRAY ARRAY['limit','initialMargin','maintenanceMargin'] LOOP
  IF NEW.policy->item IS DISTINCT FROM 'null'::jsonb AND ((NEW.policy->>item)::numeric NOT BETWEEN 0 AND 9007199254740991 OR scale((NEW.policy->>item)::numeric)>18)
  THEN RAISE EXCEPTION 'financing amount exceeds exact declared range' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF (NEW.policy->>'initialMargin' IS NULL)<>(NEW.policy->>'maintenanceMargin' IS NULL)
 OR NEW.policy->>'maintenanceMargin' IS NOT NULL AND ((NEW.policy->>'maintenanceMargin')::numeric<=0 OR (NEW.policy->>'initialMargin')::numeric<(NEW.policy->>'maintenanceMargin')::numeric)
 THEN RAISE EXCEPTION 'margin fields are paired amounts, not inferred ratios' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_financing_policy_version BEFORE INSERT ON financing_policy_versions FOR EACH ROW EXECUTE FUNCTION guard_financing_policy_version();
CREATE TRIGGER immutable_financing_policy_version BEFORE UPDATE OR DELETE ON financing_policy_versions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION guard_financing_policy_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM financing_policy_versions v WHERE v.owner_id=NEW.owner_id AND v.account_kind=NEW.account_kind AND v.request_id=NEW.request_id AND v.revision=NEW.revision)
 OR TG_OP='INSERT' AND NEW.revision<>1
 THEN RAISE EXCEPTION 'policy head must retain its own exact owner-kind version' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.owner_id<>OLD.owner_id OR NEW.account_kind<>OLD.account_kind OR NEW.revision<>OLD.revision+1 OR NOT EXISTS(SELECT 1 FROM financing_policy_versions v WHERE v.owner_id=NEW.owner_id AND v.request_id=NEW.request_id AND v.previous_id=OLD.request_id))
 THEN RAISE EXCEPTION 'policy head requires a conserved exact predecessor' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_financing_policy_head BEFORE INSERT OR UPDATE ON financing_policy_heads FOR EACH ROW EXECUTE FUNCTION guard_financing_policy_head();
CREATE TRIGGER retain_financing_policy_head BEFORE DELETE ON financing_policy_heads FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION check_financing_policy_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result->>'state'='completed' AND o.result->>'kind'='financing_policy' AND o.result->>'accountKind'=NEW.account_kind AND (o.result->>'policyRevision')::bigint=NEW.revision)
 OR NOT EXISTS(SELECT 1 FROM financing_policy_heads h WHERE h.owner_id=NEW.owner_id AND h.account_kind=NEW.account_kind AND h.request_id=NEW.request_id AND h.revision=NEW.revision)
 THEN RAISE EXCEPTION 'financing policy head and completed original UUID must commit atomically' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_financing_policy_receipt AFTER INSERT ON financing_policy_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_financing_policy_receipt();

CREATE TABLE cash_financing_confirmations (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,entry_id uuid NOT NULL UNIQUE,
 account_id text NOT NULL,account_kind text NOT NULL,currency text NOT NULL,kind text NOT NULL CHECK(kind IN ('actual_fill','cash_reconcile')),
 trade_id uuid,before_balance numeric NOT NULL,after_balance numeric NOT NULL,amount numeric NOT NULL,
 evidence jsonb NOT NULL,evidence_raw bytea NOT NULL,evidence_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id),
 FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),
 CHECK(evidence=convert_from(evidence_raw,'UTF8')::jsonb AND evidence_sha256=encode(sha256(evidence_raw),'hex')),
 CHECK(after_balance=before_balance+amount)
);
CREATE FUNCTION guard_cash_financing_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_balance numeric;original trade_ledger;declaration jsonb;
BEGIN
 PERFORM 1 FROM cash_ledger_collections WHERE owner_id=NEW.owner_id FOR UPDATE;
 SELECT coalesce(sum(amount),0) INTO actual_balance FROM cash_ledger_entries WHERE owner_id=NEW.owner_id AND account_id=NEW.account_id AND currency=NEW.currency AND account_kind=NEW.account_kind;
 declaration:=NEW.evidence->'confirmation';
 IF actual_balance IS DISTINCT FROM NEW.before_balance OR NOT EXISTS(SELECT 1 FROM broker_accounts a WHERE a.owner_id=NEW.owner_id AND a.id=NEW.account_id AND a.holding_source='manual' AND a.account_kind=NEW.account_kind AND NEW.currency=ANY(a.currencies))
 OR declaration->>'kind' IS DISTINCT FROM 'owner_statement' OR declaration->>'actualBorrowingConfirmed' IS DISTINCT FROM 'true' OR declaration->>'ledgerOnlyConfirmed' IS DISTINCT FROM 'true'
 OR declaration->>'statement' IS NULL OR length(btrim(declaration->>'statement')) NOT BETWEEN 1 AND 4096
 OR NEW.evidence->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.evidence->>'entryId' IS DISTINCT FROM NEW.entry_id::text
 OR NEW.evidence->>'accountId' IS DISTINCT FROM NEW.account_id OR NEW.evidence->>'accountKind' IS DISTINCT FROM NEW.account_kind OR NEW.evidence->>'currency' IS DISTINCT FROM NEW.currency
 THEN RAISE EXCEPTION 'negative cash requires exact current own account and explicit actual owner evidence' USING ERRCODE='23514'; END IF;
 IF NEW.kind='actual_fill' THEN
  SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
  IF original.id IS NULL OR original.request_id<>NEW.request_id OR original.cash_entry_id<>NEW.entry_id OR original.account_id<>NEW.account_id OR original.account_kind<>NEW.account_kind OR original.settlement_currency<>NEW.currency
   OR original.side<>'buy' OR original.source<>'owner_recorded' OR original.cash_delta<>NEW.amount
   OR original.input_payload->>'allowFinancing' IS DISTINCT FROM 'true' OR original.input_payload->>'confirmedActualFill' IS DISTINCT FROM 'true'
   OR original.input_payload->'financingConfirmation' IS DISTINCT FROM declaration OR original.input_payload->'feeInput'->>'source'='rule_calculated'
  THEN RAISE EXCEPTION 'actual negative-cash buy needs its own immutable actual paid fill and confirmation' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.trade_id IS NOT NULL OR NEW.evidence->'command'->>'action' IS DISTINCT FROM 'reconcile_balance'
   OR NEW.evidence->'command'->'financingConfirmation' IS DISTINCT FROM declaration OR NEW.evidence->'command'->>'allowNegativeBalance' IS DISTINCT FROM 'true'
   OR (NEW.evidence->'command'->>'amount')::numeric IS DISTINCT FROM NEW.after_balance
  THEN RAISE EXCEPTION 'signed reconcile requires its explicit actual balance declaration' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_cash_financing_confirmation BEFORE INSERT ON cash_financing_confirmations FOR EACH ROW EXECUTE FUNCTION guard_cash_financing_confirmation();
CREATE TRIGGER immutable_cash_financing_confirmation BEFORE UPDATE OR DELETE ON cash_financing_confirmations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION check_cash_financing_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=NEW.owner_id AND e.id=NEW.entry_id AND e.request_id=NEW.request_id AND e.account_id=NEW.account_id AND e.account_kind=NEW.account_kind AND e.currency=NEW.currency AND e.amount=NEW.amount AND e.affects_owner AND e.kind=CASE NEW.kind WHEN 'actual_fill' THEN 'trade_buy' ELSE 'reconcile_balance' END)
 OR (NEW.kind='actual_fill' AND NOT EXISTS(SELECT 1 FROM trade_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result->>'state'='completed' AND o.result->>'tradeId'=NEW.trade_id::text AND o.result->>'cashEntryId'=NEW.entry_id::text))
 OR (NEW.kind='cash_reconcile' AND NOT EXISTS(SELECT 1 FROM cash_ledger_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result->>'entryId'=NEW.entry_id::text AND o.result->>'action'='reconcile_balance' AND (o.result->>'balanceAfter')::numeric=NEW.after_balance))
 THEN RAISE EXCEPTION 'negative cash evidence and exact original UUID posting must be atomic' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_cash_financing_posting AFTER INSERT ON cash_financing_confirmations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_financing_posting();
CREATE FUNCTION guard_cash_debt_increase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_arg numeric;
BEGIN
 IF NEW.amount>=0 THEN RETURN NEW; END IF;
 PERFORM 1 FROM cash_ledger_collections WHERE owner_id=NEW.owner_id FOR UPDATE;
 SELECT coalesce(sum(amount),0) INTO before_arg FROM cash_ledger_entries WHERE owner_id=NEW.owner_id AND account_id IS NOT DISTINCT FROM NEW.account_id AND account_kind=NEW.account_kind AND currency=NEW.currency;
 IF before_arg+NEW.amount<0 AND NOT EXISTS(SELECT 1 FROM cash_financing_confirmations f WHERE f.owner_id=NEW.owner_id AND f.request_id=NEW.request_id AND f.entry_id=NEW.id AND f.account_id=NEW.account_id AND f.account_kind=NEW.account_kind AND f.currency=NEW.currency AND f.before_balance=before_arg AND f.after_balance=before_arg+NEW.amount AND f.amount=NEW.amount AND NEW.kind=CASE f.kind WHEN 'actual_fill' THEN 'trade_buy' ELSE 'reconcile_balance' END)
 THEN RAISE EXCEPTION 'debt increase requires explicit actual financing or signed reconciliation, never an implicit loan' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_cash_debt_increase BEFORE INSERT ON cash_ledger_entries FOR EACH ROW EXECUTE FUNCTION guard_cash_debt_increase();
