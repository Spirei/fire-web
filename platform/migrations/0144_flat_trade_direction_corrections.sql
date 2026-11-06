-- Flat-only explicit direction correction on the existing immutable event chain.
-- All owner/source/fee/CAS guards remain; cash and quantity use effective sides,
-- never the immutable original side after a prior direction correction.
ALTER TABLE trade_amendments ADD COLUMN flat_side_change boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION guard_trade_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original trade_ledger;record portfolio_records;member jsonb;current_event jsonb;previous uuid;primary_before jsonb;fee jsonb;
DECLARE total_position numeric:=0;total_quantity numeric:=0;total_amount numeric:=0;total_cash numeric:=0;new_quantity numeric:=0;new_cash numeric:=0;seen uuid[]:=ARRAY[]::uuid[];member_id uuid;member_count integer;
BEGIN
 SELECT * INTO record FROM portfolio_records WHERE owner_id=NEW.owner_id AND id=NEW.record_id FOR UPDATE;
 SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
 member_count:=jsonb_array_length(NEW.evidence->'members');
 IF NEW.flat_side_change AND (NEW.action<>'amend' OR member_count<>1 OR NEW.evidence->>'flatSideChange' IS DISTINCT FROM 'true')
 OR NOT NEW.flat_side_change AND NEW.evidence ? 'flatSideChange'
 THEN RAISE EXCEPTION 'direction correction requires explicit single-event flat evidence' USING ERRCODE='23514'; END IF;
 IF original.id IS NULL OR record.id IS NULL OR record.revision<>NEW.before_record_revision OR record.trade_tip_id<>NEW.trade_tip_id
 OR record.fee_projection_id IS DISTINCT FROM NEW.fee_projection_id OR record.qty IS DISTINCT FROM NEW.before_quantity OR record.cost IS DISTINCT FROM NEW.before_cost
 OR record.amendment_tip_id IS DISTINCT FROM NEW.previous_record_amendment_id
 OR NEW.action IS DISTINCT FROM NEW.evidence->>'action' OR member_count IS NULL OR member_count NOT BETWEEN 1 AND 100
 OR (NEW.action='merge' AND member_count<2) OR (NEW.action<>'merge' AND member_count<>1)
 OR NEW.evidence->>'kind' IS DISTINCT FROM 'owner_statement' OR NEW.evidence->>'authority' IS DISTINCT FROM 'owner_recorded'
 OR NEW.evidence->>'actualPaidConfirmed' IS DISTINCT FROM 'true' OR NEW.evidence->>'ledgerCorrectionConfirmed' IS DISTINCT FROM 'true'
 OR NEW.evidence->>'targetUserId' IS DISTINCT FROM NEW.owner_id OR NEW.evidence->>'tradeId' IS DISTINCT FROM NEW.trade_id::text
 OR NEW.evidence->>'brokerAccountId' IS DISTINCT FROM original.account_id OR NEW.evidence->>'currency' IS DISTINCT FROM NEW.currency
 OR NEW.evidence->>'originalRegistrationRequestId' IS DISTINCT FROM original.request_id::text
 OR NEW.evidence->'beforeEvent' IS DISTINCT FROM NEW.before_event OR NEW.evidence->'replacement' IS DISTINCT FROM NEW.replacement
 OR NEW.evidence->>'statement' IS NULL OR length(btrim(NEW.evidence->>'statement')) NOT BETWEEN 1 AND 4096
 THEN RAISE EXCEPTION 'correction requires exact current record CAS, explicit owner authority and bounded complete member evidence' USING ERRCODE='23514'; END IF;
 FOR member IN SELECT value FROM jsonb_array_elements(NEW.evidence->'members') LOOP
  member_id:=(member->>'tradeId')::uuid;
  IF member_id IS NULL OR member_id=ANY(seen) THEN RAISE EXCEPTION 'correction member identity is missing or duplicated' USING ERRCODE='23514'; END IF;
  seen:=array_append(seen,member_id);
  SELECT current_effective_trade_event(NEW.owner_id,member_id) INTO current_event;
  SELECT a.id INTO previous FROM trade_correction_members m JOIN trade_amendments a ON a.owner_id=m.owner_id AND a.id=m.amendment_id WHERE m.owner_id=NEW.owner_id AND m.trade_id=member_id ORDER BY a.before_record_revision DESC LIMIT 1;
  IF (NOT amendable_native_registration(NEW.owner_id,member_id) AND member->'sourceAuthority' IS NULL) OR current_event IS NULL
   OR (member->>'previousAmendmentId')::uuid IS DISTINCT FROM previous OR member->'beforeEvent' IS DISTINCT FROM current_event
   OR NOT EXISTS(SELECT 1 FROM trade_ledger t WHERE t.owner_id=NEW.owner_id AND t.id=member_id AND t.record_id=NEW.record_id AND t.account_id=original.account_id AND t.account_kind=original.account_kind AND current_event->>'side' IS NOT DISTINCT FROM current_effective_trade_event(NEW.owner_id,NEW.trade_id)->>'side' AND t.currency=NEW.currency AND t.currency=t.settlement_currency AND t.settlement_amount IS NULL AND member->>'originalRegistrationRequestId'=t.request_id::text)
  THEN RAISE EXCEPTION 'correction member must retain same active native owner original, account, side, actual event and predecessor' USING ERRCODE='23514'; END IF;
  SELECT detail INTO fee FROM trade_fee_details WHERE owner_id=NEW.owner_id AND trade_id=member_id;
  IF fee->>'source'='rule_calculated' AND NOT EXISTS(SELECT 1 FROM native_actual_fee_confirmations a JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.old_fees=a.registered_fee AND c.new_fees=a.actual_fee WHERE a.owner_id=NEW.owner_id AND a.trade_id=member_id)
  THEN RAISE EXCEPTION 'estimated original fee requires independent actual evidence' USING ERRCODE='23514'; END IF;
  IF member_id=NEW.trade_id THEN
   primary_before:=current_event;
   IF NEW.previous_amendment_id IS DISTINCT FROM previous THEN RAISE EXCEPTION 'primary correction predecessor changed' USING ERRCODE='23514'; END IF;
  END IF;
  total_position:=total_position+(current_event->>'quantity')::numeric*(CASE current_event->>'side' WHEN 'buy' THEN 1 ELSE -1 END);
  total_quantity:=total_quantity+(current_event->>'quantity')::numeric;total_amount:=total_amount+(current_event->>'amount')::numeric;
  total_cash:=total_cash+CASE current_event->>'side' WHEN 'buy' THEN -(current_event->>'amount')::numeric-(current_event->>'fees')::numeric ELSE (current_event->>'amount')::numeric-(current_event->>'fees')::numeric END;
 END LOOP;
 IF primary_before IS NULL OR NEW.before_event IS DISTINCT FROM primary_before THEN RAISE EXCEPTION 'primary original event must be one selected member' USING ERRCODE='23514'; END IF;
 IF NEW.action='delete' THEN
  IF NEW.replacement IS DISTINCT FROM NEW.before_event||'{"active":false}'::jsonb THEN RAISE EXCEPTION 'delete is an inactive exact original event, never a zero-fee invented fill' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.replacement->>'id' IS DISTINCT FROM NEW.trade_id::text OR (NEW.replacement->>'side' IS NULL OR NEW.replacement->>'side' NOT IN ('buy','sell') OR (NEW.replacement->>'side' IS DISTINCT FROM primary_before->>'side' AND NOT NEW.flat_side_change))
   OR NEW.replacement->>'currency' IS DISTINCT FROM NEW.currency OR NEW.replacement->>'settlement_currency' IS DISTINCT FROM NEW.currency
   OR NEW.replacement->'settlement_amount' IS DISTINCT FROM 'null'::jsonb OR NEW.replacement->>'created_at' IS DISTINCT FROM primary_before->>'created_at'
   OR NEW.replacement ? 'active' OR NEW.replacement->>'quantity' IS NULL OR NEW.replacement->>'price' IS NULL OR NEW.replacement->>'fees' IS NULL OR NEW.replacement->>'amount' IS NULL OR NEW.replacement->>'occurred_at' IS NULL
   OR (NEW.replacement->>'quantity')::numeric NOT BETWEEN 0.00000001 AND 1e12 OR (NEW.replacement->>'price')::numeric NOT BETWEEN 0.00000001 AND 1e12
   OR (NEW.replacement->>'fees')::numeric NOT BETWEEN 0 AND 1e12 OR (NEW.replacement->>'amount')::numeric NOT BETWEEN 0 AND 1e12
   OR scale((NEW.replacement->>'quantity')::numeric)>8 OR scale((NEW.replacement->>'price')::numeric)>8 OR scale((NEW.replacement->>'fees')::numeric)>8
   OR (NEW.replacement->>'amount')::numeric IS DISTINCT FROM (NEW.replacement->>'quantity')::numeric*(NEW.replacement->>'price')::numeric
  THEN RAISE EXCEPTION 'replacement requires bounded exact actual same-side owner event' USING ERRCODE='23514'; END IF;
  IF NEW.action='merge' AND ((NEW.replacement->>'quantity')::numeric IS DISTINCT FROM total_quantity OR (NEW.replacement->>'amount')::numeric IS DISTINCT FROM total_amount OR (NEW.replacement->>'occurred_at')::timestamptz IS DISTINCT FROM (primary_before->>'occurred_at')::timestamptz)
  THEN RAISE EXCEPTION 'merge requires conserved original quantity, principal and explicitly selected original time' USING ERRCODE='23514'; END IF;
  new_quantity:=(NEW.replacement->>'quantity')::numeric;
  new_cash:=CASE NEW.replacement->>'side' WHEN 'buy' THEN -(NEW.replacement->>'amount')::numeric-(NEW.replacement->>'fees')::numeric ELSE (NEW.replacement->>'amount')::numeric-(NEW.replacement->>'fees')::numeric END;
 END IF;
 IF NEW.cash_delta IS DISTINCT FROM new_cash-total_cash OR NEW.after_quantity IS DISTINCT FROM NEW.before_quantity+new_quantity*(CASE NEW.replacement->>'side' WHEN 'buy' THEN 1 ELSE -1 END)-total_position
 THEN RAISE EXCEPTION 'correction cash and quantity must exactly conserve selected original events' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION guard_flat_net_trade_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original trade_ledger;record portfolio_records;member jsonb;current_event jsonb;previous uuid;primary_before jsonb;fee jsonb;
DECLARE total_position numeric:=0;total_quantity numeric:=0;total_amount numeric:=0;total_cash numeric:=0;new_quantity numeric:=0;new_cash numeric:=0;seen uuid[]:=ARRAY[]::uuid[];member_id uuid;member_count integer;
BEGIN
 SELECT * INTO record FROM portfolio_records WHERE owner_id=NEW.owner_id AND id=NEW.record_id FOR UPDATE;
 SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
 member_count:=jsonb_array_length(NEW.evidence->'members');
 IF NEW.flat_side_change AND (NEW.action<>'amend' OR member_count<>1 OR NEW.evidence->>'flatSideChange' IS DISTINCT FROM 'true')
 OR NOT NEW.flat_side_change AND NEW.evidence ? 'flatSideChange'
 THEN RAISE EXCEPTION 'direction correction requires explicit single-event flat evidence' USING ERRCODE='23514'; END IF;
 IF NEW.cash_basis<>'flat_actual_net' OR NEW.action NOT IN ('amend','delete') OR NEW.currency<>'CNY'
 OR record.market<>'HK' OR record.account_market<>'CN' OR record.broker_account_id IS DISTINCT FROM original.account_id
 OR NEW.evidence->>'cashBasis' IS DISTINCT FROM 'flat_actual_net' OR NEW.evidence->>'tradeCurrency' IS DISTINCT FROM 'HKD'
 OR NEW.evidence->>'cashCurrency' IS DISTINCT FROM 'CNY' OR NEW.evidence->>'settlementNetIncludesFees' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'flat actual net correction requires exact HKD trade and independently declared CNY net' USING ERRCODE='23514'; END IF;
 IF original.id IS NULL OR record.id IS NULL OR record.revision<>NEW.before_record_revision OR record.trade_tip_id<>NEW.trade_tip_id
 OR record.fee_projection_id IS DISTINCT FROM NEW.fee_projection_id OR record.qty IS DISTINCT FROM NEW.before_quantity OR record.cost IS DISTINCT FROM NEW.before_cost
 OR record.amendment_tip_id IS DISTINCT FROM NEW.previous_record_amendment_id
 OR NEW.action IS DISTINCT FROM NEW.evidence->>'action' OR member_count IS NULL OR member_count NOT BETWEEN 1 AND 100
 OR (NEW.action='merge' AND member_count<2) OR (NEW.action<>'merge' AND member_count<>1)
 OR NEW.evidence->>'kind' IS DISTINCT FROM 'owner_statement' OR NEW.evidence->>'authority' IS DISTINCT FROM 'owner_recorded'
 OR NEW.evidence->>'actualPaidConfirmed' IS DISTINCT FROM 'true' OR NEW.evidence->>'ledgerCorrectionConfirmed' IS DISTINCT FROM 'true'
 OR NEW.evidence->>'targetUserId' IS DISTINCT FROM NEW.owner_id OR NEW.evidence->>'tradeId' IS DISTINCT FROM NEW.trade_id::text
 OR NEW.evidence->>'brokerAccountId' IS DISTINCT FROM original.account_id OR NEW.evidence->>'currency' IS DISTINCT FROM NEW.currency
 OR NEW.evidence->>'originalRegistrationRequestId' IS DISTINCT FROM original.request_id::text
 OR NEW.evidence->'beforeEvent' IS DISTINCT FROM NEW.before_event OR NEW.evidence->'replacement' IS DISTINCT FROM NEW.replacement
 OR NEW.evidence->>'statement' IS NULL OR length(btrim(NEW.evidence->>'statement')) NOT BETWEEN 1 AND 4096
 THEN RAISE EXCEPTION 'correction requires exact current record CAS, explicit owner authority and bounded complete member evidence' USING ERRCODE='23514'; END IF;
 FOR member IN SELECT value FROM jsonb_array_elements(NEW.evidence->'members') LOOP
  member_id:=(member->>'tradeId')::uuid;
  IF member_id IS NULL OR member_id=ANY(seen) THEN RAISE EXCEPTION 'correction member identity is missing or duplicated' USING ERRCODE='23514'; END IF;
  seen:=array_append(seen,member_id);
  SELECT current_effective_trade_event(NEW.owner_id,member_id) INTO current_event;
  SELECT a.id INTO previous FROM trade_correction_members m JOIN trade_amendments a ON a.owner_id=m.owner_id AND a.id=m.amendment_id WHERE m.owner_id=NEW.owner_id AND m.trade_id=member_id ORDER BY a.before_record_revision DESC LIMIT 1;
  IF (NOT amendable_flat_net_registration(NEW.owner_id,member_id) OR member ? 'sourceAuthority') OR current_event IS NULL
   OR (member->>'previousAmendmentId')::uuid IS DISTINCT FROM previous OR member->'beforeEvent' IS DISTINCT FROM current_event
   OR NOT EXISTS(SELECT 1 FROM trade_ledger t WHERE t.owner_id=NEW.owner_id AND t.id=member_id AND t.record_id=NEW.record_id AND t.account_id=original.account_id AND t.account_kind=original.account_kind AND current_event->>'side' IS NOT DISTINCT FROM current_effective_trade_event(NEW.owner_id,NEW.trade_id)->>'side' AND t.currency='HKD' AND t.settlement_currency=NEW.currency AND t.settlement_amount IS NOT NULL AND member->>'originalRegistrationRequestId'=t.request_id::text)
  THEN RAISE EXCEPTION 'correction member must retain same active native owner original, account, side, actual event and predecessor' USING ERRCODE='23514'; END IF;
  SELECT detail INTO fee FROM trade_fee_details WHERE owner_id=NEW.owner_id AND trade_id=member_id;
  IF fee->>'source'='rule_calculated' AND NOT EXISTS(SELECT 1 FROM native_actual_fee_confirmations a JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.old_fees=a.registered_fee AND c.new_fees=a.actual_fee WHERE a.owner_id=NEW.owner_id AND a.trade_id=member_id)
  THEN RAISE EXCEPTION 'estimated original fee requires independent actual evidence' USING ERRCODE='23514'; END IF;
  IF member_id=NEW.trade_id THEN
   primary_before:=current_event;
   IF NEW.previous_amendment_id IS DISTINCT FROM previous THEN RAISE EXCEPTION 'primary correction predecessor changed' USING ERRCODE='23514'; END IF;
  END IF;
  total_position:=total_position+(current_event->>'quantity')::numeric*(CASE current_event->>'side' WHEN 'buy' THEN 1 ELSE -1 END);
  total_quantity:=total_quantity+(current_event->>'quantity')::numeric;total_amount:=total_amount+(current_event->>'amount')::numeric;
  total_cash:=total_cash+CASE current_event->>'side' WHEN 'buy' THEN -(current_event->>'settlement_amount')::numeric ELSE (current_event->>'settlement_amount')::numeric END;
 END LOOP;
 IF primary_before IS NULL OR NEW.before_event IS DISTINCT FROM primary_before THEN RAISE EXCEPTION 'primary original event must be one selected member' USING ERRCODE='23514'; END IF;
 IF NEW.action='delete' THEN
  IF NEW.replacement IS DISTINCT FROM NEW.before_event||'{"active":false}'::jsonb THEN RAISE EXCEPTION 'delete is an inactive exact original event, never a zero-fee invented fill' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.replacement->>'id' IS DISTINCT FROM NEW.trade_id::text OR (NEW.replacement->>'side' IS NULL OR NEW.replacement->>'side' NOT IN ('buy','sell') OR (NEW.replacement->>'side' IS DISTINCT FROM primary_before->>'side' AND NOT NEW.flat_side_change))
   OR NEW.replacement->>'currency' IS DISTINCT FROM 'HKD' OR NEW.replacement->>'settlement_currency' IS DISTINCT FROM NEW.currency
   OR NEW.replacement->>'settlement_amount' IS NULL OR (NEW.replacement->>'settlement_amount')::numeric NOT BETWEEN 0 AND 1e12 OR scale((NEW.replacement->>'settlement_amount')::numeric)>8 OR NEW.replacement->>'created_at' IS DISTINCT FROM primary_before->>'created_at'
   OR NEW.replacement ? 'active' OR NEW.replacement->>'quantity' IS NULL OR NEW.replacement->>'price' IS NULL OR NEW.replacement->>'fees' IS NULL OR NEW.replacement->>'amount' IS NULL OR NEW.replacement->>'occurred_at' IS NULL
   OR (NEW.replacement->>'quantity')::numeric NOT BETWEEN 0.00000001 AND 1e12 OR (NEW.replacement->>'price')::numeric NOT BETWEEN 0.00000001 AND 1e12
   OR (NEW.replacement->>'fees')::numeric NOT BETWEEN 0 AND 1e12 OR (NEW.replacement->>'amount')::numeric NOT BETWEEN 0 AND 1e12
   OR scale((NEW.replacement->>'quantity')::numeric)>8 OR scale((NEW.replacement->>'price')::numeric)>8 OR scale((NEW.replacement->>'fees')::numeric)>8
   OR (NEW.replacement->>'amount')::numeric IS DISTINCT FROM (NEW.replacement->>'quantity')::numeric*(NEW.replacement->>'price')::numeric
  THEN RAISE EXCEPTION 'replacement requires bounded exact actual same-side owner event' USING ERRCODE='23514'; END IF;
  IF NEW.action='merge' AND ((NEW.replacement->>'quantity')::numeric IS DISTINCT FROM total_quantity OR (NEW.replacement->>'amount')::numeric IS DISTINCT FROM total_amount OR (NEW.replacement->>'occurred_at')::timestamptz IS DISTINCT FROM (primary_before->>'occurred_at')::timestamptz)
  THEN RAISE EXCEPTION 'merge requires conserved original quantity, principal and explicitly selected original time' USING ERRCODE='23514'; END IF;
  new_quantity:=(NEW.replacement->>'quantity')::numeric;
  new_cash:=CASE NEW.replacement->>'side' WHEN 'buy' THEN -(NEW.replacement->>'settlement_amount')::numeric ELSE (NEW.replacement->>'settlement_amount')::numeric END;
 END IF;
 IF NEW.cash_delta IS DISTINCT FROM new_cash-total_cash OR NEW.after_quantity IS DISTINCT FROM NEW.before_quantity+new_quantity*(CASE NEW.replacement->>'side' WHEN 'buy' THEN 1 ELSE -1 END)-total_position
 THEN RAISE EXCEPTION 'correction cash and quantity must exactly conserve selected original events' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;