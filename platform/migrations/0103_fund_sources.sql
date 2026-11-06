-- Manual funding sources share cash postings; deletions append reversals and tombstones.
ALTER TABLE cash_ledger_entries DROP CONSTRAINT cash_ledger_entries_check;
ALTER TABLE cash_ledger_entries ADD CONSTRAINT cash_unallocated_posting_scope CHECK(account_id IS NOT NULL OR kind IN ('opening','external_deposit','external_withdrawal','reconcile_balance'));
ALTER TABLE cash_ledger_entries ADD COLUMN reversal_entry_id uuid REFERENCES cash_ledger_entries(id);
CREATE UNIQUE INDEX cash_reversal_once ON cash_ledger_entries(owner_id,reversal_entry_id) WHERE reversal_entry_id IS NOT NULL;
CREATE TABLE fund_sources (
 owner_id text NOT NULL REFERENCES users(id), id text NOT NULL, request_id uuid NOT NULL,
 cash_entry_id uuid NOT NULL REFERENCES cash_ledger_entries(id), account_id text,
 account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')), currency text NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision=1), origin_type text NOT NULL CHECK(origin_type IN ('opening','deposit','withdrawal','adjustment')), action text NOT NULL CHECK(action IN ('opening','external_deposit','external_withdrawal','reconcile_balance')),
 amount numeric NOT NULL, amount_basis text NOT NULL DEFAULT 'cash_command_amount' CHECK(amount_basis IN ('cash_command_amount','legacy_signed_posting')), delta numeric NOT NULL, note text NOT NULL, occurred_at timestamptz NOT NULL,
 authority text NOT NULL DEFAULT 'owner_recorded' CHECK(authority='owner_recorded'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,request_id), UNIQUE(owner_id,cash_entry_id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TRIGGER fund_source_retained BEFORE UPDATE OR DELETE ON fund_sources FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
CREATE TABLE fund_source_retirements (
 owner_id text NOT NULL, source_id text NOT NULL, request_id uuid NOT NULL, reversal_entry_id uuid NOT NULL REFERENCES cash_ledger_entries(id),
 evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,source_id), UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,source_id) REFERENCES fund_sources(owner_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES cash_ledger_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER fund_retirement_retained BEFORE UPDATE OR DELETE ON fund_source_retirements FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
CREATE TABLE fund_source_previews (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL, request_id uuid NOT NULL,
 payload jsonb NOT NULL, payload_hash text NOT NULL, source_id text NOT NULL, cash_preview_hash text NOT NULL,
 authorization_binding text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,id)
);
CREATE TRIGGER fund_preview_retained BEFORE UPDATE ON fund_source_previews FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
CREATE TABLE fund_source_operations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL, request_hash text, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER fund_receipt_retained BEFORE UPDATE OR DELETE ON fund_source_operations FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
CREATE TABLE cash_reconciliation_evidence (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL, entry_id uuid NOT NULL REFERENCES cash_ledger_entries(id),
 account_id text, account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')), currency text NOT NULL,
 registered_before numeric NOT NULL, target_balance numeric NOT NULL, delta numeric NOT NULL,
 evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id),
 CHECK(target_balance-registered_before=delta),
 FOREIGN KEY(owner_id,request_id) REFERENCES cash_ledger_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER cash_reconciliation_retained BEFORE UPDATE OR DELETE ON cash_reconciliation_evidence FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
CREATE FUNCTION guard_fund_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e cash_ledger_entries;
BEGIN
 SELECT * INTO e FROM cash_ledger_entries WHERE id=NEW.cash_entry_id;
 IF e.id IS NULL OR e.owner_id<>NEW.owner_id OR e.request_id<>NEW.request_id OR e.account_kind<>NEW.account_kind OR e.currency<>NEW.currency
 OR e.account_id IS DISTINCT FROM NEW.account_id OR e.kind<>NEW.action OR e.amount<>NEW.delta OR NOT e.affects_owner
 OR e.reversal_entry_id IS NOT NULL OR e.source_trade_id IS NOT NULL OR e.occurred_at<>NEW.occurred_at OR e.note<>NEW.note
 OR (NEW.action IN ('opening','external_deposit') AND NEW.amount<>e.amount)
 OR (NEW.action='external_withdrawal' AND NEW.amount<>-e.amount)
 OR (NEW.action='reconcile_balance' AND NEW.amount_basis='cash_command_amount' AND NOT EXISTS(SELECT 1 FROM cash_reconciliation_evidence p WHERE p.owner_id=NEW.owner_id AND p.request_id=NEW.request_id AND p.entry_id=e.id AND p.target_balance=NEW.amount))
 OR (NEW.amount_basis='legacy_signed_posting' AND NEW.amount<>abs(e.amount))
 OR (NOT EXISTS(SELECT 1 FROM cash_ledger_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result->>'entryId'=e.id::text)
     AND NOT EXISTS(SELECT 1 FROM financial_import_links l JOIN financial_import_operations o ON o.owner_id=l.owner_id AND o.request_id=l.operation_id WHERE l.owner_id=NEW.owner_id AND l.object_kind='cash' AND l.original_id=NEW.id AND l.target_id=e.id::text
     AND l.original->>'originalScope' IN ('unallocated','broker') AND l.original->>'accountKind'=e.account_kind AND l.original->>'currency'=e.currency AND (l.original->>'amount')::numeric=e.amount
     AND l.original->>'orderId' IS NULL AND o.result->>'financialApplied'='true' AND o.result->>'state'='completed'))
 THEN RAISE EXCEPTION 'fund source requires its exact original manual cash posting' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fund_source_checked BEFORE INSERT ON fund_sources FOR EACH ROW EXECUTE FUNCTION guard_fund_source();
CREATE FUNCTION guard_fund_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original cash_ledger_entries;
BEGIN
 IF NEW.reversal_entry_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO original FROM cash_ledger_entries WHERE id=NEW.reversal_entry_id FOR SHARE;
 IF original.id IS NULL OR original.owner_id<>NEW.owner_id OR original.account_kind<>NEW.account_kind OR original.currency<>NEW.currency
 OR original.account_id IS DISTINCT FROM NEW.account_id OR original.amount<>-NEW.amount OR NOT original.affects_owner OR NOT NEW.affects_owner
 OR original.source_trade_id IS NOT NULL OR original.reversal_entry_id IS NOT NULL
 OR NEW.kind NOT IN ('external_deposit','external_withdrawal')
 OR NOT EXISTS(SELECT 1 FROM fund_sources f WHERE f.owner_id=NEW.owner_id AND f.cash_entry_id=original.id AND f.authority='owner_recorded')
 THEN RAISE EXCEPTION 'fund retirement requires its exact unlinked inverse posting' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fund_reversal_checked BEFORE INSERT ON cash_ledger_entries FOR EACH ROW EXECUTE FUNCTION guard_fund_reversal();
CREATE FUNCTION guard_fund_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f fund_sources; e cash_ledger_entries;
BEGIN
 SELECT * INTO f FROM fund_sources WHERE owner_id=NEW.owner_id AND id=NEW.source_id;
 SELECT * INTO e FROM cash_ledger_entries WHERE id=NEW.reversal_entry_id;
 IF f.id IS NULL OR e.id IS NULL OR e.owner_id<>NEW.owner_id OR e.request_id<>NEW.request_id OR e.reversal_entry_id IS DISTINCT FROM f.cash_entry_id
 THEN RAISE EXCEPTION 'fund tombstone requires its original inverse receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fund_retirement_checked BEFORE INSERT ON fund_source_retirements FOR EACH ROW EXECUTE FUNCTION guard_fund_retirement();
CREATE FUNCTION guard_cash_reconciliation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e cash_ledger_entries; before_balance numeric;
BEGIN
 SELECT * INTO e FROM cash_ledger_entries WHERE id=NEW.entry_id;
 IF e.id IS NULL OR e.owner_id<>NEW.owner_id OR e.request_id<>NEW.request_id OR e.kind<>'reconcile_balance'
 OR e.currency<>NEW.currency OR e.account_kind<>NEW.account_kind OR e.account_id IS DISTINCT FROM NEW.account_id OR e.amount<>NEW.delta
 OR NEW.evidence->>'authority' IS DISTINCT FROM 'owner_declared_observation'
 THEN RAISE EXCEPTION 'reconciliation evidence requires exact owner-scoped difference posting' USING ERRCODE='23514'; END IF;
 IF NEW.account_id IS NULL THEN
  SELECT coalesce(sum(amount) FILTER(WHERE affects_owner),0)-coalesce(sum(amount) FILTER(WHERE account_id IS NOT NULL),0)
  INTO before_balance FROM cash_ledger_entries WHERE owner_id=NEW.owner_id AND account_kind=NEW.account_kind AND currency=NEW.currency AND id<>NEW.entry_id;
 ELSE
  SELECT coalesce(sum(amount),0) INTO before_balance FROM cash_ledger_entries WHERE owner_id=NEW.owner_id AND account_kind=NEW.account_kind AND currency=NEW.currency AND account_id=NEW.account_id AND id<>NEW.entry_id;
 END IF;
 IF before_balance IS DISTINCT FROM NEW.registered_before THEN
  RAISE EXCEPTION 'cash reconciliation must retain its actual registered before balance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_reconciliation_checked BEFORE INSERT ON cash_reconciliation_evidence FOR EACH ROW EXECUTE FUNCTION guard_cash_reconciliation_evidence();
CREATE FUNCTION guard_unallocated_cash() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE available numeric; total numeric; reserved numeric;
BEGIN
 IF NEW.account_id IS NOT NULL THEN RETURN NEW; END IF;
 IF NEW.kind='opening' THEN
  IF EXISTS(SELECT 1 FROM cash_ledger_entries WHERE owner_id=NEW.owner_id AND account_kind=NEW.account_kind AND currency=NEW.currency AND account_id IS NULL)
  THEN RAISE EXCEPTION 'unallocated opening already exists' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM cash_ledger_entries WHERE owner_id=NEW.owner_id AND account_kind=NEW.account_kind AND currency=NEW.currency AND account_id IS NULL AND kind='opening' AND occurred_at<=NEW.occurred_at)
  THEN RAISE EXCEPTION 'unallocated cash requires its independent opening' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT coalesce(sum(amount) FILTER(WHERE affects_owner),0),coalesce(sum(amount) FILTER(WHERE affects_owner),0)-coalesce(sum(amount) FILTER(WHERE account_id IS NOT NULL),0)
 INTO total,available FROM cash_ledger_entries WHERE owner_id=NEW.owner_id AND account_kind=NEW.account_kind AND currency=NEW.currency;
 SELECT coalesce(sum(reservation_cash),0) INTO reserved FROM internal_orders WHERE owner_id=NEW.owner_id AND account_kind=NEW.account_kind AND currency=NEW.currency AND status='pending';
 IF NEW.amount<0 AND (available+NEW.amount<0 OR total+NEW.amount<reserved)
 THEN RAISE EXCEPTION 'unallocated posting exceeds proven unallocated or reserved cash' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER unallocated_cash_checked BEFORE INSERT ON cash_ledger_entries FOR EACH ROW EXECUTE FUNCTION guard_unallocated_cash();
