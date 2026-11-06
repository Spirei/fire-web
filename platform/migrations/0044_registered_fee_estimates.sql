CREATE TABLE legacy_fee_source_account_bindings (
 owner_id text NOT NULL REFERENCES users(id),source_instance text NOT NULL,source_owner text NOT NULL,
 source_account_id text NOT NULL,account_id text NOT NULL,first_manifest_id uuid NOT NULL,
 PRIMARY KEY(owner_id,source_instance,source_owner,source_account_id),UNIQUE(owner_id,source_instance,source_owner,account_id),
 FOREIGN KEY(owner_id,first_manifest_id) REFERENCES legacy_source_manifests(owner_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE FUNCTION guard_legacy_fee_source_account_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original legacy_source_manifests;source_account jsonb;
BEGIN
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.first_manifest_id;
 SELECT row INTO source_account FROM jsonb_array_elements(convert_from(original.raw,'UTF8')::jsonb->'tables'->'broker_accounts'->'rows') row WHERE row->'id'->>'text'=NEW.source_account_id;
 IF original.manifest->'source'->>'instance' IS DISTINCT FROM NEW.source_instance OR original.manifest->'source'->>'owner' IS DISTINCT FROM NEW.source_owner
 OR source_account IS NULL OR NOT EXISTS(SELECT 1 FROM broker_accounts b WHERE b.owner_id=NEW.owner_id AND b.id=NEW.account_id AND b.account_kind=source_account->'account_kind'->>'text' AND b.provider_id=source_account->'provider_id'->>'text' AND b.holding_source='manual')
 THEN RAISE EXCEPTION 'registered account metadata must retain the verified original identity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_fee_source_account_binding BEFORE INSERT ON legacy_fee_source_account_bindings FOR EACH ROW EXECUTE FUNCTION guard_legacy_fee_source_account_binding();
CREATE TRIGGER legacy_fee_source_account_binding_immutable BEFORE UPDATE OR DELETE ON legacy_fee_source_account_bindings FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
-- Assess an existing registered zero without turning an estimate into an actual posting.
CREATE TABLE legacy_fee_baseline_bindings (
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,first_manifest_id uuid NOT NULL,
 source_instance text NOT NULL,source_owner text NOT NULL,original_order_id text NOT NULL,
 trade_id uuid NOT NULL,cash_entry_id uuid NOT NULL,record_id text NOT NULL,account_id text NOT NULL,
 registered_fee numeric NOT NULL CHECK(registered_fee=0),actual_fee_known boolean NOT NULL CHECK(NOT actual_fee_known),
 original_row jsonb NOT NULL,canonical_snapshot jsonb NOT NULL,prefix_proof jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id),
 UNIQUE(owner_id,source_instance,source_owner,original_order_id),UNIQUE(owner_id,trade_id),
 FOREIGN KEY(owner_id,first_manifest_id) REFERENCES legacy_source_manifests(owner_id,id),
 FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),
 FOREIGN KEY(cash_entry_id) REFERENCES cash_ledger_entries(id)
);
CREATE TABLE legacy_fee_estimation_previews (
 token_hash text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),session_hash text NOT NULL,
 fingerprint text NOT NULL,dependencies jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',consumed_at timestamptz
);
CREATE TABLE legacy_fee_estimation_operations (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),
 CHECK(result->>'financialApplied'='false')
);
CREATE TABLE legacy_fee_estimates (
 owner_id text NOT NULL,request_id uuid NOT NULL,manifest_id uuid NOT NULL,account_id text NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),previous_request_id uuid,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),UNIQUE(owner_id,account_id,revision),
 FOREIGN KEY(owner_id,request_id) REFERENCES legacy_fee_estimation_operations(owner_id,request_id),
 FOREIGN KEY(owner_id,manifest_id) REFERENCES legacy_source_manifests(owner_id,id),
 FOREIGN KEY(owner_id,previous_request_id) REFERENCES legacy_fee_estimates(owner_id,request_id),
 CHECK(result->>'authority'='rule_calculated' AND result->>'financialApplied'='false'
   AND result->>'actualFeeKnown'='false' AND result->>'state'='completed')
);
CREATE TABLE legacy_fee_estimation_heads (
 owner_id text NOT NULL REFERENCES users(id),account_id text NOT NULL,revision bigint NOT NULL,request_id uuid NOT NULL,
 PRIMARY KEY(owner_id,account_id),FOREIGN KEY(owner_id,request_id) REFERENCES legacy_fee_estimates(owner_id,request_id)
);
CREATE FUNCTION legacy_fee_registered_target_snapshot(owner_arg text,trade_arg uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT legacy_mapping_target_snapshot(owner_arg,'order',trade_arg::text)||jsonb_build_object(
 'before_quantity',before_quantity::text,'before_cost',before_cost::text,'after_quantity',after_quantity::text,
 'after_cost',after_cost::text,'before_record_revision',before_record_revision,'previous_trade_id',previous_trade_id::text)
 FROM trade_ledger WHERE owner_id=owner_arg AND id=trade_arg
$$;
CREATE FUNCTION guard_registered_fee_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original legacy_source_manifests;target trade_ledger;facts jsonb;source_row jsonb;item jsonb;proof jsonb;registered numeric;source_account text;source_broker jsonb;source_opening jsonb;target_opening numeric;
BEGIN
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.first_manifest_id;
 facts=original.manifest->'orderFacts'->NEW.original_order_id;
 SELECT row INTO source_row FROM jsonb_array_elements(convert_from(original.raw,'UTF8')::jsonb->'tables'->'trade_orders'->'rows') row WHERE row->'id'->>'text'=NEW.original_order_id;
 SELECT * INTO target FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
 IF facts->>'registeredFee' IS NULL OR (facts->>'registeredFee')::numeric<>0 OR facts->>'actualFeeKnown' IS DISTINCT FROM 'false'
 OR source_row IS NULL OR source_row->'fees'->>'text' IS NULL OR (source_row->'fees'->>'text')::numeric<>0
 OR NEW.original_row IS DISTINCT FROM source_row OR NEW.canonical_snapshot IS DISTINCT FROM legacy_fee_registered_target_snapshot(NEW.owner_id,NEW.trade_id)
 OR target.id IS NULL OR target.source NOT IN ('unverified_legacy','legacy_import_zero') OR target.fees<>0
 OR target.cash_entry_id<>NEW.cash_entry_id OR target.record_id<>NEW.record_id OR target.account_id<>NEW.account_id
 OR NEW.source_instance IS DISTINCT FROM original.manifest->'source'->>'instance'
 OR NEW.source_owner IS DISTINCT FROM original.manifest->'source'->>'owner'
 OR NOT EXISTS(SELECT 1 FROM cash_ledger_entries e WHERE e.id=NEW.cash_entry_id AND e.owner_id=NEW.owner_id AND e.source_trade_id=NEW.trade_id AND e.request_id=target.request_id)
 OR target.cash_delta IS DISTINCT FROM (facts->'cashProjection'->>'exactStoredDecimalNet')::numeric
 THEN RAISE EXCEPTION 'registered baseline must retain an existing unresolved zero and its real raw zero' USING ERRCODE='23514'; END IF;
 SELECT row->'account_id'->>'text' INTO source_account FROM jsonb_array_elements(convert_from(original.raw,'UTF8')::jsonb->'tables'->'broker_cash_order_links'->'rows') row WHERE row->'order_id'->>'text'=NEW.original_order_id;
 SELECT row INTO source_broker FROM jsonb_array_elements(convert_from(original.raw,'UTF8')::jsonb->'tables'->'broker_accounts'->'rows') row WHERE row->'id'->>'text'=source_account;
 SELECT row INTO source_opening FROM jsonb_array_elements(convert_from(original.raw,'UTF8')::jsonb->'tables'->'broker_cash_accounts'->'rows') row WHERE row->'account_id'->>'text'=source_account AND row->'currency'->>'text'=target.settlement_currency;
 SELECT e.amount INTO target_opening FROM cash_ledger_accounts a JOIN cash_ledger_entries e ON e.owner_id=a.owner_id AND e.account_id=a.account_id AND e.currency=a.currency AND e.request_id=a.opening_request_id WHERE a.owner_id=NEW.owner_id AND a.account_id=NEW.account_id AND a.currency=target.settlement_currency AND a.opening_basis='new_external_opening' AND e.affects_owner;
 IF source_account IS NULL OR source_broker IS NULL OR source_opening IS NULL OR source_opening->'opening_amount'->>'text' IS NULL
 OR (source_opening->'opening_amount'->>'text')::numeric IS DISTINCT FROM target_opening
 OR NOT EXISTS(SELECT 1 FROM broker_accounts b WHERE b.owner_id=NEW.owner_id AND b.id=NEW.account_id AND b.account_kind=source_broker->'account_kind'->>'text' AND b.provider_id=source_broker->'provider_id'->>'text' AND b.holding_source='manual')
 THEN RAISE EXCEPTION 'registered baseline requires original broker identity and exact registered cash opening' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM legacy_source_grants g JOIN legacy_source_owner_claims c ON c.owner_id=g.owner_id AND c.source_instance=g.source_instance AND c.source_owner=g.source_owner AND c.physical_identity_hash=g.physical_identity_hash
 WHERE g.id=original.grant_id AND g.owner_id=NEW.owner_id AND g.state='active' AND g.revision=original.grant_revision
 AND g.platform_instance=(SELECT instance_id FROM alcor_instance WHERE singleton) FOR SHARE OF g)
 THEN RAISE EXCEPTION 'registered baseline requires its current verified source owner permission' USING ERRCODE='23514'; END IF;
 INSERT INTO legacy_fee_source_account_bindings VALUES(NEW.owner_id,NEW.source_instance,NEW.source_owner,source_account,NEW.account_id,NEW.first_manifest_id) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM legacy_fee_source_account_bindings WHERE owner_id=NEW.owner_id AND source_instance=NEW.source_instance AND source_owner=NEW.source_owner AND source_account_id=source_account AND account_id=NEW.account_id)
 THEN RAISE EXCEPTION 'original account association cannot split or silently merge across targets' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(NEW.prefix_proof)<>(SELECT count(*) FROM trade_ledger WHERE owner_id=NEW.owner_id AND record_id=NEW.record_id)
 THEN RAISE EXCEPTION 'registered baseline requires the whole existing canonical record prefix' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(NEW.prefix_proof)<>(SELECT count(*) FROM jsonb_array_elements(convert_from(original.raw,'UTF8')::jsonb->'tables'->'trade_orders'->'rows') row WHERE row->'record_id'->>'text'=source_row->'record_id'->>'text' AND row->'status'->>'text'='filled') THEN RAISE EXCEPTION 'registered binding cannot omit original record history' USING ERRCODE='23514'; END IF;
 FOR proof IN SELECT value FROM jsonb_array_elements(NEW.prefix_proof) LOOP
  SELECT row INTO item FROM jsonb_array_elements(convert_from(original.raw,'UTF8')::jsonb->'tables'->'trade_orders'->'rows') row WHERE row->'id'->>'text'=proof->>'originalOrderId';
  IF item IS NULL OR item->'fees'->>'text' IS NULL OR (item->'fees'->>'text')::numeric IS DISTINCT FROM (proof->'source'->>'registered_fee')::numeric THEN RAISE EXCEPTION 'registered prefix never substitutes zero for a missing source fee' USING ERRCODE='23514'; END IF;
  IF proof->'canonical' IS DISTINCT FROM legacy_fee_registered_target_snapshot(NEW.owner_id,(proof->>'tradeId')::uuid)
   OR proof->'source'->>'registered_fee' IS NULL
  THEN RAISE EXCEPTION 'registered prefix cannot replace target economics or missing original fee with zero' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_registered_fee_baseline BEFORE INSERT ON legacy_fee_baseline_bindings FOR EACH ROW EXECUTE FUNCTION guard_registered_fee_baseline();
CREATE FUNCTION guard_fee_estimate_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous legacy_fee_estimation_heads;original legacy_source_manifests;value jsonb;
BEGIN
 SELECT * INTO previous FROM legacy_fee_estimation_heads WHERE owner_id=NEW.owner_id AND account_id=NEW.account_id FOR UPDATE;
 IF NEW.revision<>coalesce(previous.revision,0)+1 OR NEW.previous_request_id IS DISTINCT FROM previous.request_id
 THEN RAISE EXCEPTION 'fee estimate requires exact predecessor CAS' USING ERRCODE='23514'; END IF;
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 IF NOT EXISTS(SELECT 1 FROM legacy_source_grants g WHERE g.id=original.grant_id AND g.owner_id=NEW.owner_id AND g.state='active' AND g.revision=original.grant_revision AND g.platform_instance=(SELECT instance_id FROM alcor_instance WHERE singleton) FOR SHARE OF g)
 THEN RAISE EXCEPTION 'new fee estimate requires its current source grant' USING ERRCODE='23514'; END IF;
 FOR value IN SELECT item FROM jsonb_array_elements(NEW.result->'assessments') item LOOP
  IF value->'actual'->>'feesKnown' IS DISTINCT FROM 'false'
   OR value->'actual'->'cost' IS DISTINCT FROM 'null'::jsonb OR value->'actual'->'realizedPnl' IS DISTINCT FROM 'null'::jsonb
   OR value->'actual'->'cashBalance' IS DISTINCT FROM 'null'::jsonb OR value->>'financialApplied' IS DISTINCT FROM 'false'
   OR value->>'authority' IS DISTINCT FROM 'rule_calculated'
  THEN RAISE EXCEPTION 'a rate estimate never establishes actual cost cash or realized pnl' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_fee_estimate_version BEFORE INSERT ON legacy_fee_estimates FOR EACH ROW EXECUTE FUNCTION guard_fee_estimate_version();
CREATE FUNCTION guard_fee_estimation_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legacy_fee_estimates WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id AND account_id=NEW.account_id AND revision=NEW.revision)
 OR (TG_OP='INSERT' AND NEW.revision<>1) OR (TG_OP='UPDATE' AND (NEW.owner_id<>OLD.owner_id OR NEW.account_id<>OLD.account_id OR NEW.revision<>OLD.revision+1))
 THEN RAISE EXCEPTION 'fee estimate head must match its exact committed metadata version' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_fee_estimation_head BEFORE INSERT OR UPDATE ON legacy_fee_estimation_heads FOR EACH ROW EXECUTE FUNCTION guard_fee_estimation_head();
CREATE TRIGGER registered_fee_binding_immutable BEFORE UPDATE OR DELETE ON legacy_fee_baseline_bindings FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER fee_estimate_immutable BEFORE UPDATE OR DELETE ON legacy_fee_estimates FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER fee_estimation_receipt_immutable BEFORE UPDATE OR DELETE ON legacy_fee_estimation_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
