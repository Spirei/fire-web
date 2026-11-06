-- Corrections remain in the same signed cash ledger and original UUID chain.
ALTER TABLE cash_financing_confirmations DROP CONSTRAINT cash_financing_confirmations_kind_check;
ALTER TABLE cash_financing_confirmations ADD CONSTRAINT cash_financing_confirmations_kind_check CHECK(kind IN ('actual_fill','cash_reconcile','trade_correction'));
CREATE OR REPLACE FUNCTION guard_cash_financing_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
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
 ELSIF NEW.kind='cash_reconcile' THEN
  IF NEW.trade_id IS NOT NULL OR NEW.evidence->'command'->>'action' IS DISTINCT FROM 'reconcile_balance'
   OR NEW.evidence->'command'->'financingConfirmation' IS DISTINCT FROM declaration OR NEW.evidence->'command'->>'allowNegativeBalance' IS DISTINCT FROM 'true'
   OR (NEW.evidence->'command'->>'amount')::numeric IS DISTINCT FROM NEW.after_balance
  THEN RAISE EXCEPTION 'signed reconcile requires its explicit actual balance declaration' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM trade_amendments a WHERE a.owner_id=NEW.owner_id AND a.id=(NEW.evidence->>'amendmentId')::uuid AND a.request_id=NEW.request_id AND a.trade_id=NEW.trade_id AND a.currency=NEW.currency AND a.cash_delta=NEW.amount AND a.evidence->'financingConfirmation'=declaration AND a.evidence->>'brokerAccountId'=NEW.account_id AND a.evidence->>'targetUserId'=NEW.owner_id)
  OR NEW.evidence->'command'->'financingConfirmation' IS DISTINCT FROM declaration
  THEN RAISE EXCEPTION 'financed correction needs its exact immutable amendment and owner confirmation' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION check_cash_financing_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=NEW.owner_id AND e.id=NEW.entry_id AND e.request_id=NEW.request_id AND e.account_id=NEW.account_id AND e.account_kind=NEW.account_kind AND e.currency=NEW.currency AND e.amount=NEW.amount AND e.affects_owner AND e.kind=CASE NEW.kind WHEN 'actual_fill' THEN 'trade_buy' WHEN 'trade_correction' THEN 'trade_correction' ELSE 'reconcile_balance' END)
 OR (NEW.kind='actual_fill' AND NOT EXISTS(SELECT 1 FROM trade_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result->>'state'='completed' AND o.result->>'tradeId'=NEW.trade_id::text AND o.result->>'cashEntryId'=NEW.entry_id::text))
 OR (NEW.kind='cash_reconcile' AND NOT EXISTS(SELECT 1 FROM cash_ledger_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result->>'entryId'=NEW.entry_id::text AND o.result->>'action'='reconcile_balance' AND (o.result->>'balanceAfter')::numeric=NEW.after_balance))
 OR (NEW.kind='trade_correction' AND NOT EXISTS(SELECT 1 FROM trade_operations o JOIN cash_ledger_entries e ON e.owner_id=o.owner_id AND e.request_id=o.request_id WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result->>'state'='completed' AND o.result->>'kind'='trade_amendment' AND o.result->>'amendmentId'=NEW.evidence->>'amendmentId' AND e.id=NEW.entry_id AND e.trade_amendment_id=(NEW.evidence->>'amendmentId')::uuid))
 THEN RAISE EXCEPTION 'negative cash evidence and exact original UUID posting must be atomic' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_cash_debt_increase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_arg numeric;
BEGIN
 IF NEW.amount>=0 THEN RETURN NEW; END IF;
 PERFORM 1 FROM cash_ledger_collections WHERE owner_id=NEW.owner_id FOR UPDATE;
 SELECT coalesce(sum(amount),0) INTO before_arg FROM cash_ledger_entries WHERE owner_id=NEW.owner_id AND account_id IS NOT DISTINCT FROM NEW.account_id AND account_kind=NEW.account_kind AND currency=NEW.currency;
 IF before_arg+NEW.amount<0 AND NOT EXISTS(SELECT 1 FROM cash_financing_confirmations f WHERE f.owner_id=NEW.owner_id AND f.request_id=NEW.request_id AND f.entry_id=NEW.id AND f.account_id=NEW.account_id AND f.account_kind=NEW.account_kind AND f.currency=NEW.currency AND f.before_balance=before_arg AND f.after_balance=before_arg+NEW.amount AND f.amount=NEW.amount AND NEW.kind=CASE f.kind WHEN 'actual_fill' THEN 'trade_buy' WHEN 'trade_correction' THEN 'trade_correction' ELSE 'reconcile_balance' END)
 THEN RAISE EXCEPTION 'debt increase requires explicit actual financing or signed reconciliation, never an implicit loan' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
