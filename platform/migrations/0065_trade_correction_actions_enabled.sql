-- Extend the existing immutable amendment chain; do not rewrite raw fills/cash.
CREATE OR REPLACE FUNCTION current_effective_trade_event(owner_arg text,trade_arg uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE result jsonb;disposition_arg text;
BEGIN
 SELECT a.replacement,m.disposition INTO result,disposition_arg FROM trade_correction_members m JOIN trade_amendments a ON a.owner_id=m.owner_id AND a.id=m.amendment_id WHERE m.owner_id=owner_arg AND m.trade_id=trade_arg ORDER BY a.before_record_revision DESC LIMIT 1;
 IF FOUND THEN RETURN CASE WHEN disposition_arg='retained' THEN result ELSE NULL END; END IF;
 SELECT jsonb_build_object('id',t.id,'side',t.side,'quantity',t.quantity::text,'price',t.price::text,'amount',t.amount::text,
  'fees',coalesce(c.new_fees,t.fees)::text,'currency',t.currency,'settlement_currency',t.settlement_currency,
  'settlement_amount',t.settlement_amount::text,'occurred_at',t.occurred_at,'created_at',t.created_at)
 INTO result FROM trade_ledger t LEFT JOIN trade_fee_corrections c ON c.owner_id=t.owner_id AND c.trade_id=t.id WHERE t.owner_id=owner_arg AND t.id=trade_arg;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION guard_trade_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original trade_ledger;record portfolio_records;member jsonb;current_event jsonb;previous uuid;primary_before jsonb;fee jsonb;
DECLARE total_quantity numeric:=0;total_amount numeric:=0;total_cash numeric:=0;new_quantity numeric:=0;new_cash numeric:=0;seen uuid[]:=ARRAY[]::uuid[];member_id uuid;member_count integer;
BEGIN
 SELECT * INTO record FROM portfolio_records WHERE owner_id=NEW.owner_id AND id=NEW.record_id FOR UPDATE;
 SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
 member_count:=jsonb_array_length(NEW.evidence->'members');
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
  IF NOT amendable_native_registration(NEW.owner_id,member_id) OR current_event IS NULL
   OR (member->>'previousAmendmentId')::uuid IS DISTINCT FROM previous OR member->'beforeEvent' IS DISTINCT FROM current_event
   OR NOT EXISTS(SELECT 1 FROM trade_ledger t WHERE t.owner_id=NEW.owner_id AND t.id=member_id AND t.record_id=NEW.record_id AND t.account_id=original.account_id AND t.account_kind=original.account_kind AND t.side=original.side AND t.currency=NEW.currency AND t.currency=t.settlement_currency AND t.settlement_amount IS NULL AND member->>'originalRegistrationRequestId'=t.request_id::text)
  THEN RAISE EXCEPTION 'correction member must retain same active native owner original, account, side, actual event and predecessor' USING ERRCODE='23514'; END IF;
  SELECT detail INTO fee FROM trade_fee_details WHERE owner_id=NEW.owner_id AND trade_id=member_id;
  IF fee->>'source'='rule_calculated' AND NOT EXISTS(SELECT 1 FROM native_actual_fee_confirmations a JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.old_fees=a.registered_fee AND c.new_fees=a.actual_fee WHERE a.owner_id=NEW.owner_id AND a.trade_id=member_id)
  THEN RAISE EXCEPTION 'estimated original fee requires independent actual evidence' USING ERRCODE='23514'; END IF;
  IF member_id=NEW.trade_id THEN
   primary_before:=current_event;
   IF NEW.previous_amendment_id IS DISTINCT FROM previous THEN RAISE EXCEPTION 'primary correction predecessor changed' USING ERRCODE='23514'; END IF;
  END IF;
  total_quantity:=total_quantity+(current_event->>'quantity')::numeric;total_amount:=total_amount+(current_event->>'amount')::numeric;
  total_cash:=total_cash+CASE original.side WHEN 'buy' THEN -(current_event->>'amount')::numeric-(current_event->>'fees')::numeric ELSE (current_event->>'amount')::numeric-(current_event->>'fees')::numeric END;
 END LOOP;
 IF primary_before IS NULL OR NEW.before_event IS DISTINCT FROM primary_before THEN RAISE EXCEPTION 'primary original event must be one selected member' USING ERRCODE='23514'; END IF;
 IF NEW.action='delete' THEN
  IF NEW.replacement IS DISTINCT FROM NEW.before_event||'{"active":false}'::jsonb THEN RAISE EXCEPTION 'delete is an inactive exact original event, never a zero-fee invented fill' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.replacement->>'id' IS DISTINCT FROM NEW.trade_id::text OR NEW.replacement->>'side' IS DISTINCT FROM original.side
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
  new_cash:=CASE original.side WHEN 'buy' THEN -(NEW.replacement->>'amount')::numeric-(NEW.replacement->>'fees')::numeric ELSE (NEW.replacement->>'amount')::numeric-(NEW.replacement->>'fees')::numeric END;
 END IF;
 IF NEW.cash_delta IS DISTINCT FROM new_cash-total_cash OR NEW.after_quantity IS DISTINCT FROM NEW.before_quantity+(new_quantity-total_quantity)*(CASE original.side WHEN 'buy' THEN 1 ELSE -1 END)
 THEN RAISE EXCEPTION 'correction cash and quantity must exactly conserve selected original events' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_single_trade_correction_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE amendment trade_amendments;member jsonb;
BEGIN
 SELECT * INTO amendment FROM trade_amendments WHERE owner_id=NEW.owner_id AND id=NEW.amendment_id;
 SELECT value INTO member FROM jsonb_array_elements(amendment.evidence->'members') WHERE value->>'tradeId'=NEW.trade_id::text;
 IF amendment.id IS NULL OR member IS NULL OR NEW.previous_member_amendment_id IS DISTINCT FROM (member->>'previousAmendmentId')::uuid
 OR NEW.before_event IS DISTINCT FROM member->'beforeEvent'
 OR NEW.disposition IS DISTINCT FROM (CASE WHEN amendment.action='delete' THEN 'deleted' WHEN NEW.trade_id=amendment.trade_id THEN 'retained' ELSE 'superseded' END)
 OR NEW.target_replacement_id IS DISTINCT FROM (CASE WHEN amendment.action='delete' THEN NULL ELSE amendment.replacement_id END)
 THEN RAISE EXCEPTION 'member must bind exact immutable action evidence and disposition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION bind_single_trade_correction_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member jsonb;trade_arg uuid;
BEGIN
 FOR member IN SELECT value FROM jsonb_array_elements(NEW.evidence->'members') LOOP
  trade_arg:=(member->>'tradeId')::uuid;
  INSERT INTO trade_correction_members(owner_id,amendment_id,trade_id,previous_member_amendment_id,disposition,before_event,target_replacement_id)
   VALUES(NEW.owner_id,NEW.id,trade_arg,(member->>'previousAmendmentId')::uuid,CASE WHEN NEW.action='delete' THEN 'deleted' WHEN trade_arg=NEW.trade_id THEN 'retained' ELSE 'superseded' END,member->'beforeEvent',CASE WHEN NEW.action='delete' THEN NULL ELSE NEW.replacement_id END);
 END LOOP;
 RETURN NEW;
END $$;
