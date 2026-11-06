-- Original-source authority for the same immutable amendment/member chain.
-- Index a bounded captured manifest once per statement, not once per fill.
CREATE FUNCTION source_trade_correction_context(owner_arg text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE m legacy_source_manifests;g legacy_source_grants;h legacy_source_heads;raw jsonb;answer jsonb;orders jsonb;records jsonb;accounts jsonb;links jsonb;financial_orders jsonb;table_arg text;key_arg text;rows_arg jsonb;
BEGIN
 SELECT * INTO h FROM legacy_source_heads WHERE owner_id=owner_arg;
 SELECT * INTO m FROM legacy_source_manifests WHERE owner_id=owner_arg AND id=h.manifest_id;
 SELECT * INTO g FROM legacy_source_grants WHERE id=m.grant_id AND owner_id=owner_arg;
 IF m.id IS NULL OR g.id IS NULL OR g.state<>'active' OR g.revision<>m.grant_revision
 OR g.platform_instance<>(SELECT instance_id FROM alcor_instance WHERE singleton)
 OR (m.manifest->'coverage'->>'complete') IS DISTINCT FROM 'true' OR (m.manifest->'coverage'->>'ownerVerified') IS DISTINCT FROM 'true'
 OR (m.manifest->'coverage'->>'datasetIdentityVerified') IS DISTINCT FROM 'true'
 OR g.source_instance IS DISTINCT FROM m.manifest->'source'->>'instance' OR g.source_owner IS DISTINCT FROM m.manifest->'source'->>'owner'
 OR g.binding_hash IS DISTINCT FROM m.manifest->>'sourceBindingHash' OR h.manifest_sha256 IS DISTINCT FROM m.manifest_sha256
 OR NOT EXISTS(SELECT 1 FROM legacy_source_owner_claims c WHERE c.owner_id=owner_arg AND c.source_instance=g.source_instance AND c.source_owner=g.source_owner AND c.physical_identity_hash=g.physical_identity_hash AND c.platform_instance=g.platform_instance)
 OR NOT EXISTS(SELECT 1 FROM legacy_source_operations o WHERE o.owner_id=owner_arg AND o.state='completed' AND o.result->>'manifestId'=m.id::text AND o.result->>'manifestSha256'=m.manifest_sha256 AND o.result->>'sourceBindingHash'=g.binding_hash)
 THEN RETURN NULL; END IF;
 raw:=convert_from(m.raw,'UTF8')::jsonb;
 FOREACH table_arg IN ARRAY ARRAY['trade_orders','records','broker_accounts','broker_cash_order_links'] LOOP
  key_arg:=CASE WHEN table_arg='broker_cash_order_links' THEN 'order_id' ELSE 'id' END;
  rows_arg:=raw->'tables'->table_arg->'rows';
  IF jsonb_typeof(rows_arg) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(rows_arg) value WHERE value->key_arg->>'text' IS NULL)
   OR (SELECT count(*)<>count(DISTINCT value->key_arg->>'text') FROM jsonb_array_elements(rows_arg) value)
  THEN RETURN NULL; END IF;
 END LOOP;
 SELECT jsonb_object_agg(value#>>'{id,text}',value) INTO orders FROM jsonb_array_elements(raw#>'{tables,trade_orders,rows}');
 SELECT jsonb_object_agg(value#>>'{id,text}',value) INTO records FROM jsonb_array_elements(raw#>'{tables,records,rows}');
 SELECT jsonb_object_agg(value#>>'{id,text}',value) INTO accounts FROM jsonb_array_elements(raw#>'{tables,broker_accounts,rows}');
 SELECT jsonb_object_agg(value#>>'{order_id,text}',value) INTO links FROM jsonb_array_elements(raw#>'{tables,broker_cash_order_links,rows}');
 SELECT jsonb_object_agg(value->>'id',value) INTO financial_orders FROM jsonb_array_elements(convert_from(m.financial_raw,'UTF8')::jsonb->'orders');
 RETURN jsonb_build_object('base',jsonb_build_object('manifestId',m.id::text,'manifestSha256',m.manifest_sha256,'sourceRevision',h.revision,'grantId',g.id::text,'grantRevision',g.revision,'sourceInstance',g.source_instance,'sourceOwner',g.source_owner,'sourceRawSha256',m.manifest->>'rawSha256'),'orders',orders,'records',records,'accounts',accounts,'links',links,'financialOrders',financial_orders,'orderFacts',m.manifest->'orderFacts');
END $$;
CREATE FUNCTION source_trade_correction_in_context(owner_arg text,trade_arg uuid,context_arg jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE t trade_ledger;a broker_accounts;g legacy_source_grants;
DECLARE link financial_import_links;cash_link financial_import_links;b legacy_fee_baseline_bindings;actual actual_fee_confirmations;
DECLARE old_order jsonb;old_record jsonb;old_account jsonb;old_link jsonb;current_order jsonb;receipt jsonb;fact jsonb;lane text;oid text;source_account text;
BEGIN
 IF context_arg IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO t FROM trade_ledger WHERE owner_id=owner_arg AND id=trade_arg;
 SELECT * INTO a FROM broker_accounts WHERE owner_id=owner_arg AND id=t.account_id AND deleted_at IS NULL;
 SELECT * INTO g FROM legacy_source_grants WHERE id=(context_arg->'base'->>'grantId')::uuid;
 IF t.id IS NULL OR a.id IS NULL OR a.holding_source<>'manual' OR t.side NOT IN ('buy','sell') OR t.currency<>t.settlement_currency OR t.settlement_amount IS NOT NULL THEN RETURN NULL; END IF;
 SELECT * INTO link FROM financial_import_links WHERE owner_id=owner_arg AND source_instance=g.source_instance AND source_owner=g.source_owner AND object_kind='order' AND target_id=t.id::text;
 IF link.original_id IS NOT NULL THEN
  lane:='financial_import';oid:=link.original_id;source_account:=link.original->>'sourceAccountId';
  SELECT * INTO cash_link FROM financial_import_links WHERE owner_id=owner_arg AND source_instance=g.source_instance AND source_owner=g.source_owner AND object_kind='cash' AND original_id=link.original->>'cashId' AND target_id=t.cash_entry_id::text;
  SELECT result INTO receipt FROM financial_import_operations WHERE owner_id=owner_arg AND request_id=link.operation_id;
  IF cash_link.original_id IS NULL OR cash_link.operation_id<>link.operation_id OR cash_link.source_id<>link.source_id
   OR receipt->>'state' IS DISTINCT FROM 'completed' OR receipt->>'financialApplied' IS DISTINCT FROM 'true' OR receipt->>'sourceId' IS DISTINCT FROM link.source_id::text
   OR cash_link.original->>'orderId' IS DISTINCT FROM oid OR cash_link.original->>'sourceAccountId' IS DISTINCT FROM source_account
   OR t.source NOT IN ('owner_recorded','broker_reported') OR link.original->>'feeAuthority' IS DISTINCT FROM t.source
   OR (link.original->>'fees')::numeric IS DISTINCT FROM t.fees
   OR NOT EXISTS(SELECT 1 FROM trade_operations o WHERE o.owner_id=owner_arg AND o.request_id=t.request_id AND o.result->>'state'='completed' AND o.result->>'tradeId'=t.id::text AND o.result->>'cashEntryId'=t.cash_entry_id::text AND o.result->>'provenance'='legacy_imported' AND o.result->>'importOperationId'=link.operation_id::text)
  THEN RETURN NULL; END IF;
  current_order:=context_arg->'financialOrders'->oid;
  IF current_order IS NULL OR legacy_mapping_semantics(current_order) IS DISTINCT FROM legacy_mapping_semantics(link.original) THEN RETURN NULL; END IF;
 ELSE
  lane:='registered_baseline_actual';
  SELECT * INTO b FROM legacy_fee_baseline_bindings WHERE owner_id=owner_arg AND trade_id=t.id AND source_instance=g.source_instance AND source_owner=g.source_owner;
  SELECT x.* INTO actual FROM actual_fee_confirmations x JOIN trade_fee_corrections c ON c.owner_id=x.owner_id AND c.trade_id=x.trade_id AND c.request_id=x.request_id AND c.old_fees=0 AND c.new_fees=x.actual_fee WHERE x.owner_id=owner_arg AND x.trade_id=t.id AND x.baseline_id=b.id AND x.authority='owner_recorded';
  IF b.id IS NULL OR actual.request_id IS NULL OR b.cash_entry_id<>t.cash_entry_id OR b.record_id<>t.record_id OR b.account_id<>t.account_id OR t.fees<>0 OR t.source NOT IN ('legacy_import_zero','unverified_legacy') THEN RETURN NULL; END IF;
  oid:=b.original_order_id;
 END IF;
 old_order:=context_arg->'orders'->oid;
 old_record:=context_arg->'records'->(old_order#>>'{record_id,text}');
 old_link:=context_arg->'links'->oid;
 IF lane='registered_baseline_actual' THEN
  IF old_order IS DISTINCT FROM b.original_row THEN RETURN NULL; END IF;
  source_account:=old_link#>>'{account_id,text}';
 END IF;
 old_account:=context_arg->'accounts'->source_account;
 fact:=context_arg->'orderFacts'->oid;
 IF old_order IS NULL OR old_record IS NULL OR old_account IS NULL OR old_link IS NULL
  OR old_order#>>'{user_id,text}' IS DISTINCT FROM g.source_owner OR old_order#>>'{status,text}' IS DISTINCT FROM 'filled'
  OR old_order#>>'{side,text}' IS DISTINCT FROM t.side OR old_account#>>'{holding_source,text}' IS DISTINCT FROM 'manual'
  OR old_account#>>'{user_id,text}' IS DISTINCT FROM g.source_owner OR old_account#>>'{provider_id,text}' IS DISTINCT FROM a.provider_id
  OR old_account#>>'{account_kind,text}' IS DISTINCT FROM a.account_kind OR old_link#>>'{account_id,text}' IS DISTINCT FROM source_account OR old_link#>>'{currency,text}' IS DISTINCT FROM t.currency
  OR (old_order#>>'{qty,text}')::numeric IS DISTINCT FROM t.quantity OR (old_order#>>'{price,text}')::numeric IS DISTINCT FROM t.price
  OR (old_order#>>'{amount,text}')::numeric IS DISTINCT FROM t.amount OR (old_order#>>'{fees,text}')::numeric IS DISTINCT FROM t.fees
  OR (old_order#>>'{traded_at,text}')::timestamptz IS DISTINCT FROM t.occurred_at
  OR NOT EXISTS(SELECT 1 FROM portfolio_records r WHERE r.owner_id=owner_arg AND r.id=t.record_id AND r.broker_account_id=t.account_id AND r.market=old_record#>>'{market,text}' AND r.code=old_record#>>'{code,text}' AND r.account_market=coalesce(old_record#>>'{account_market,text}',''))
  OR NOT EXISTS(SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=owner_arg AND e.id=t.cash_entry_id AND e.source_trade_id=t.id AND e.request_id=t.request_id AND e.account_id=t.account_id AND e.account_kind=t.account_kind AND e.currency=t.currency AND e.amount=t.cash_delta AND e.affects_owner)
  OR (lane='financial_import' AND fact->>'actualFeeKnown' IS DISTINCT FROM 'true')
 THEN RETURN NULL; END IF;
 RETURN (context_arg->'base')||jsonb_build_object('lane',lane,'sourceOrderId',oid,'sourceAccountId',source_account,'originalImportRequestId',link.operation_id::text,'originalRequestId',CASE WHEN lane='financial_import' THEN link.original_uuid::text ELSE (SELECT value->'source'->>'original_request_id' FROM jsonb_array_elements(b.prefix_proof) WHERE value->>'tradeId'=t.id::text LIMIT 1) END,'baselineId',b.id::text,'actualConfirmationId',actual.request_id::text,'registrationRequestId',t.request_id::text,'cashEntryId',t.cash_entry_id::text,'brokerExecution',false);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
CREATE FUNCTION source_trade_correction_authority(owner_arg text,trade_arg uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT source_trade_correction_in_context(owner_arg,trade_arg,source_trade_correction_context(owner_arg)) $$;
CREATE FUNCTION source_trade_correction_authorities(owner_arg text,trades_arg uuid[]) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH context AS MATERIALIZED(SELECT source_trade_correction_context(owner_arg) value),authorities AS MATERIALIZED(SELECT id,source_trade_correction_in_context(owner_arg,id,context.value) value FROM unnest(trades_arg) id CROSS JOIN context)
 SELECT coalesce(jsonb_object_agg(id::text,value) FILTER(WHERE value IS NOT NULL),'{}'::jsonb) FROM authorities
$$;
CREATE FUNCTION amendable_ledger_registration(owner_arg text,trade_arg uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT amendable_native_registration(owner_arg,trade_arg) OR source_trade_correction_authority(owner_arg,trade_arg) IS NOT NULL $$;

CREATE FUNCTION guard_source_trade_correction_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member jsonb;authority jsonb;context_arg jsonb;permission legacy_source_grants;source_head legacy_source_heads;
BEGIN
 FOR member IN SELECT value FROM jsonb_array_elements(NEW.evidence->'members') LOOP
  IF amendable_native_registration(NEW.owner_id,(member->>'tradeId')::uuid) THEN
   IF member ? 'sourceAuthority' THEN RAISE EXCEPTION 'native original cannot borrow source authority' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT * INTO permission FROM legacy_source_grants WHERE id=(member->'sourceAuthority'->>'grantId')::uuid AND owner_id=NEW.owner_id FOR SHARE;
   PERFORM 1 FROM legacy_source_owner_claims WHERE owner_id=NEW.owner_id AND source_instance=permission.source_instance AND source_owner=permission.source_owner FOR SHARE;
   SELECT * INTO source_head FROM legacy_source_heads WHERE owner_id=NEW.owner_id FOR SHARE;
   IF context_arg IS NULL THEN context_arg:=source_trade_correction_context(NEW.owner_id); END IF;
   authority:=source_trade_correction_in_context(NEW.owner_id,(member->>'tradeId')::uuid,context_arg);
   IF authority IS NULL OR member->'sourceAuthority' IS DISTINCT FROM authority THEN RAISE EXCEPTION 'imported correction needs exact current source grant owner head original and actual authority' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_source_trade_correction_authority BEFORE INSERT ON trade_amendments FOR EACH ROW EXECUTE FUNCTION guard_source_trade_correction_authority();

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
  IF (NOT amendable_native_registration(NEW.owner_id,member_id) AND member->'sourceAuthority' IS NULL) OR current_event IS NULL
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

