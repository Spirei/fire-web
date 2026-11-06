-- Append-only provenance over the canonical ledgers. No balances are stored here.
CREATE TABLE legacy_financial_mapping_versions (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,manifest_id uuid NOT NULL,
 import_request_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 predecessor_id uuid,predecessor_sha256 text,sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 content jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),UNIQUE(owner_id,revision),
 FOREIGN KEY(owner_id,manifest_id) REFERENCES legacy_source_manifests(owner_id,id),
 FOREIGN KEY(owner_id,import_request_id) REFERENCES financial_import_operations(owner_id,request_id),
 FOREIGN KEY(owner_id,predecessor_id) REFERENCES legacy_financial_mapping_versions(owner_id,request_id),
 CHECK((revision=1 AND predecessor_id IS NULL AND predecessor_sha256 IS NULL) OR
       (revision>1 AND predecessor_id IS NOT NULL AND predecessor_sha256 IS NOT NULL))
);
CREATE TABLE legacy_financial_mapping_items (
 owner_id text NOT NULL,mapping_request_id uuid NOT NULL,object_kind text NOT NULL,original_id text NOT NULL,
 source_instance text NOT NULL,source_owner text NOT NULL,target_id text NOT NULL,canonical_snapshot jsonb NOT NULL,
 PRIMARY KEY(owner_id,mapping_request_id,object_kind,original_id),
 FOREIGN KEY(owner_id,mapping_request_id) REFERENCES legacy_financial_mapping_versions(owner_id,request_id),
 FOREIGN KEY(owner_id,source_instance,source_owner,object_kind,original_id)
 REFERENCES financial_import_links(owner_id,source_instance,source_owner,object_kind,original_id)
);
CREATE TABLE legacy_financial_mapping_heads (
 owner_id text PRIMARY KEY REFERENCES users(id),request_id uuid NOT NULL,revision bigint NOT NULL,sha256 text NOT NULL,
 FOREIGN KEY(owner_id,request_id) REFERENCES legacy_financial_mapping_versions(owner_id,request_id)
);
CREATE TABLE legacy_financial_mapping_previews (
 token_hash text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),session_hash text NOT NULL,
 fingerprint text NOT NULL,dependencies jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',consumed_at timestamptz
);
CREATE FUNCTION legacy_mapping_target_snapshot(owner_arg text,kind_arg text,target_arg text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE answer jsonb;
BEGIN
 IF kind_arg='record' THEN
  SELECT jsonb_build_object('rowType','record','id',r.id,'broker_account_id',r.broker_account_id,'code',r.code,'market',r.market,
   'account_market',r.account_market,'source',r.source,'revision',r.revision,'qty',r.qty::text,'cost',r.cost::text,'trade_tip_id',r.trade_tip_id::text) INTO answer
  FROM portfolio_records r WHERE r.owner_id=owner_arg AND r.id=target_arg AND r.deleted_at IS NULL;
 ELSIF kind_arg='cash' THEN
  SELECT jsonb_build_object('rowType','cash','id',e.id::text,'account_id',e.account_id,'account_kind',e.account_kind,
   'request_id',e.request_id::text,'currency',e.currency,'kind',e.kind,'amount',e.amount::text,'affects_owner',e.affects_owner,
   'occurred_at',e.occurred_at::text,'source_trade_id',e.source_trade_id::text) INTO answer
  FROM cash_ledger_entries e WHERE e.owner_id=owner_arg AND e.id::text=target_arg;
 ELSE
  SELECT jsonb_build_object('rowType','trade','id',t.id::text,'record_id',t.record_id,'account_id',t.account_id,'account_kind',t.account_kind,
   'request_id',t.request_id::text,'side',t.side,'quantity',t.quantity::text,'price',t.price::text,'amount',t.amount::text,'fees',t.fees::text,
   'currency',t.currency,'settlement_currency',t.settlement_currency,'settlement_amount',t.settlement_amount::text,
   'cash_delta',t.cash_delta::text,'cash_entry_id',t.cash_entry_id::text,'source',t.source,'occurred_at',t.occurred_at::text) INTO answer
  FROM trade_ledger t WHERE t.owner_id=owner_arg AND t.id::text=target_arg;
  IF answer IS NULL THEN
   SELECT jsonb_build_object('rowType','intent','id',i.id::text,'record_id',i.record_id,'account_id',i.account_id,'account_kind',i.account_kind,
    'side',i.side,'quantity',i.quantity::text,'price',i.limit_price::text,'fees',i.fees::text,'currency',i.currency,
    'order_type',i.order_type,'status',i.status,'original_status',i.import_original_status,'original_intent',i.import_original_intent) INTO answer
   FROM internal_orders i WHERE i.owner_id=owner_arg AND i.id::text=target_arg;
  END IF;
 END IF;
 RETURN answer;
END $$;
CREATE FUNCTION guard_legacy_mapping_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original legacy_source_manifests;receipt jsonb;previous legacy_financial_mapping_heads;source jsonb;
BEGIN
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 source=convert_from(original.financial_raw,'UTF8')::jsonb;
 SELECT result INTO receipt FROM financial_import_operations WHERE owner_id=NEW.owner_id AND request_id=NEW.import_request_id;
 IF receipt->>'state' IS DISTINCT FROM 'completed' OR receipt->>'financialApplied' IS DISTINCT FROM 'true'
 OR receipt->>'sourceId' IS DISTINCT FROM NEW.manifest_id::text
 OR NOT EXISTS(SELECT 1 FROM legacy_source_grants g JOIN legacy_source_owner_claims c ON c.owner_id=g.owner_id AND c.source_instance=g.source_instance
  AND c.source_owner=g.source_owner AND c.physical_identity_hash=g.physical_identity_hash
  WHERE g.id=original.grant_id AND g.owner_id=NEW.owner_id AND g.state='active' AND g.revision=original.grant_revision
   AND g.platform_instance=(SELECT instance_id FROM alcor_instance WHERE singleton) FOR SHARE OF g)
 THEN RAISE EXCEPTION 'mapping requires the same authorized source and completed financial receipt' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM legacy_financial_mapping_heads WHERE owner_id=NEW.owner_id FOR UPDATE;
 IF NEW.revision<>coalesce(previous.revision,0)+1 OR NEW.predecessor_id IS DISTINCT FROM previous.request_id
 OR NEW.predecessor_sha256 IS DISTINCT FROM previous.sha256
 THEN RAISE EXCEPTION 'mapping version requires exact predecessor CAS' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(NEW.content->'items')<>jsonb_array_length(source->'records')+jsonb_array_length(source->'cash')+jsonb_array_length(source->'orders') THEN RAISE EXCEPTION 'mapping cannot omit source objects' USING ERRCODE='23514'; END IF;
 IF NEW.sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.content::text,'UTF8')),'hex') OR NEW.content->>'manifestSha256' IS DISTINCT FROM original.manifest_sha256 OR NEW.content->>'importRequestId' IS DISTINCT FROM NEW.import_request_id::text
 OR NEW.result->>'financialApplied' IS DISTINCT FROM 'false' OR NEW.result->>'linkedFinancialApplied' IS DISTINCT FROM 'true'
 OR NEW.result->>'mappingSha256' IS DISTINCT FROM NEW.sha256
 THEN RAISE EXCEPTION 'mapping does not replace the source or its financial receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_mapping_version BEFORE INSERT ON legacy_financial_mapping_versions FOR EACH ROW EXECUTE FUNCTION guard_legacy_mapping_version();
CREATE FUNCTION legacy_mapping_semantics(value_arg jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE answer jsonb;
BEGIN
 IF jsonb_typeof(value_arg)='object' THEN
  SELECT coalesce(jsonb_object_agg(key,legacy_mapping_semantics(value)),'{}'::jsonb) INTO answer FROM jsonb_each(value_arg) WHERE key NOT IN ('evidenceId','feeEvidenceId');
 ELSIF jsonb_typeof(value_arg)='array' THEN
  SELECT coalesce(jsonb_agg(legacy_mapping_semantics(value)),'[]'::jsonb) INTO answer FROM jsonb_array_elements(value_arg);
 ELSE answer=value_arg; END IF;
 RETURN answer;
END $$;
CREATE FUNCTION guard_legacy_mapping_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch legacy_financial_mapping_versions;link financial_import_links;snapshot jsonb;wanted jsonb;source_original jsonb;
BEGIN
 SELECT * INTO batch FROM legacy_financial_mapping_versions WHERE owner_id=NEW.owner_id AND request_id=NEW.mapping_request_id;
 SELECT * INTO link FROM financial_import_links WHERE owner_id=NEW.owner_id AND source_instance=NEW.source_instance AND source_owner=NEW.source_owner
  AND object_kind=NEW.object_kind AND original_id=NEW.original_id;
 SELECT item INTO wanted FROM jsonb_array_elements(batch.content->'items') item WHERE item->>'objectKind'=NEW.object_kind AND item->>'originalId'=NEW.original_id;
 SELECT item INTO source_original FROM legacy_source_manifests m, jsonb_array_elements(convert_from(m.financial_raw,'UTF8')::jsonb->(CASE NEW.object_kind WHEN 'record' THEN 'records' WHEN 'cash' THEN 'cash' ELSE 'orders' END)) item WHERE m.owner_id=NEW.owner_id AND m.id=batch.manifest_id AND item->>'id'=NEW.original_id;
 snapshot=legacy_mapping_target_snapshot(NEW.owner_id,NEW.object_kind,NEW.target_id);
 IF source_original IS NULL OR (CASE NEW.object_kind WHEN 'record' THEN legacy_mapping_semantics(link.original)-'version'-'closing' WHEN 'cash' THEN legacy_mapping_semantics(link.original)-'version' ELSE legacy_mapping_semantics(link.original) END) IS DISTINCT FROM (CASE NEW.object_kind WHEN 'record' THEN legacy_mapping_semantics(source_original)-'version'-'closing' WHEN 'cash' THEN legacy_mapping_semantics(source_original)-'version' ELSE legacy_mapping_semantics(source_original) END)
 OR wanted->>'originManifestId' IS DISTINCT FROM link.source_id::text OR wanted->>'originImportRequestId' IS DISTINCT FROM link.operation_id::text
 OR NOT EXISTS(WITH RECURSIVE chain AS (SELECT m.* FROM legacy_source_manifests m WHERE m.owner_id=NEW.owner_id AND m.id=batch.manifest_id UNION ALL SELECT m.* FROM legacy_source_manifests m JOIN chain c ON m.owner_id=c.owner_id AND m.manifest_sha256=c.predecessor_hash) SELECT 1 FROM chain WHERE id=link.source_id)
 OR NOT EXISTS(SELECT 1 FROM financial_import_operations WHERE owner_id=NEW.owner_id AND request_id=link.operation_id AND result->>'state'='completed' AND result->>'financialApplied'='true')
 OR link.target_id IS DISTINCT FROM NEW.target_id OR snapshot IS NULL OR snapshot IS DISTINCT FROM NEW.canonical_snapshot
 OR wanted->'canonical' IS DISTINCT FROM NEW.canonical_snapshot OR wanted->>'targetId' IS DISTINCT FROM NEW.target_id
 OR wanted->>'sourceInstance' IS DISTINCT FROM NEW.source_instance OR wanted->>'sourceOwner' IS DISTINCT FROM NEW.source_owner
 THEN RAISE EXCEPTION 'mapping must match original provenance and the actual canonical target' USING ERRCODE='23514'; END IF;
 IF NEW.object_kind='order' THEN
  IF link.original->>'status'='filled' THEN
   IF snapshot->>'rowType'<>'trade' OR snapshot->>'source' IS DISTINCT FROM link.original->>'feeAuthority'
    OR (snapshot->>'quantity')::numeric IS DISTINCT FROM (link.original->>'quantity')::numeric
    OR (snapshot->>'price')::numeric IS DISTINCT FROM (link.original->>'price')::numeric
    OR (snapshot->>'amount')::numeric IS DISTINCT FROM (link.original->>'amount')::numeric
    OR (snapshot->>'fees')::numeric IS DISTINCT FROM (link.original->>'fees')::numeric
    OR snapshot->>'side' IS DISTINCT FROM link.original->>'side' OR snapshot->>'currency' IS DISTINCT FROM link.original->>'currency'
    OR snapshot->>'settlement_currency' IS DISTINCT FROM link.original->>'settlementCurrency'
    OR (snapshot->>'settlement_amount')::numeric IS DISTINCT FROM (link.original->>'settlementAmount')::numeric
    OR (snapshot->>'occurred_at')::timestamptz IS DISTINCT FROM (link.original->>'occurredAt')::timestamptz
    OR link.original->>'fees' IS NULL
   THEN RAISE EXCEPTION 'mapped fill must retain exact original economics and known actual fees' USING ERRCODE='23514'; END IF;
  ELSE
   IF snapshot->>'rowType'<>'intent' OR snapshot->>'order_type'<>'imported'
    OR snapshot->>'original_status' IS DISTINCT FROM link.original->>'status'
    OR snapshot->'original_intent' IS DISTINCT FROM link.original->'intent'
    OR (snapshot->>'quantity')::numeric IS DISTINCT FROM (link.original->>'quantity')::numeric
    OR (snapshot->>'price')::numeric IS DISTINCT FROM (link.original->>'price')::numeric
    OR (snapshot->>'fees')::numeric IS DISTINCT FROM (link.original->>'fees')::numeric
    OR snapshot->>'currency' IS DISTINCT FROM link.original->>'settlementCurrency'
    THEN RAISE EXCEPTION 'nonfilled source intent cannot map to a fill' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF NEW.object_kind='record' THEN
  IF snapshot->>'rowType'<>'record' OR snapshot->>'code' IS DISTINCT FROM link.original->>'code'
   OR snapshot->>'market' IS DISTINCT FROM link.original->>'market' OR snapshot->>'account_market' IS DISTINCT FROM link.original->>'accountMarket'
  THEN RAISE EXCEPTION 'mapped record security must match the source' USING ERRCODE='23514'; END IF;
 ELSIF NEW.object_kind='cash' THEN
  IF (snapshot->>'amount')::numeric IS DISTINCT FROM (link.original->>'amount')::numeric
   OR snapshot->>'currency' IS DISTINCT FROM link.original->>'currency' OR snapshot->>'kind' IS DISTINCT FROM link.original->>'kind'
   OR (snapshot->>'affects_owner')::boolean IS DISTINCT FROM (link.original->>'affectsOwner')::boolean
   OR (snapshot->>'occurred_at')::timestamptz IS DISTINCT FROM (link.original->>'occurredAt')::timestamptz
  THEN RAISE EXCEPTION 'mapped cash must retain the exact original posting' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_mapping_item BEFORE INSERT ON legacy_financial_mapping_items FOR EACH ROW EXECUTE FUNCTION guard_legacy_mapping_item();
CREATE FUNCTION check_legacy_mapping_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
 SELECT count(*) INTO n FROM legacy_financial_mapping_items WHERE owner_id=NEW.owner_id AND mapping_request_id=NEW.request_id;
 IF n<>jsonb_array_length(NEW.content->'items') THEN RAISE EXCEPTION 'mapping must contain every committed canonical item' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_legacy_mapping_items AFTER INSERT ON legacy_financial_mapping_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_legacy_mapping_items();
CREATE FUNCTION guard_legacy_mapping_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version legacy_financial_mapping_versions;
BEGIN
 SELECT * INTO version FROM legacy_financial_mapping_versions WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id;
 IF version.revision<>NEW.revision OR version.sha256<>NEW.sha256 OR (TG_OP='UPDATE' AND (version.predecessor_id IS DISTINCT FROM OLD.request_id OR NEW.owner_id<>OLD.owner_id))
 THEN RAISE EXCEPTION 'mapping head must match the committed version' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_mapping_head BEFORE INSERT OR UPDATE ON legacy_financial_mapping_heads FOR EACH ROW EXECUTE FUNCTION guard_legacy_mapping_head();
CREATE TRIGGER legacy_mapping_version_immutable BEFORE UPDATE OR DELETE ON legacy_financial_mapping_versions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER legacy_mapping_item_immutable BEFORE UPDATE OR DELETE ON legacy_financial_mapping_items FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE TABLE legacy_financial_mapping_receipts(owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(owner_id,request_id));
CREATE TRIGGER legacy_mapping_receipt_immutable BEFORE UPDATE OR DELETE ON legacy_financial_mapping_receipts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

-- Attribution is provenance only, yet new statements still require source access.
-- Existing completed attribution receipts remain readable after revocation.
CREATE FUNCTION guard_legacy_mapping_attribution_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legacy_source_heads h
 JOIN legacy_source_view_bindings b ON b.owner_id=h.owner_id AND b.manifest_id=h.manifest_id AND b.view_kind='fees' AND b.view_sha256=NEW.source_digest
 JOIN legacy_source_manifests m ON m.owner_id=h.owner_id AND m.id=h.manifest_id
 JOIN legacy_source_grants g ON g.id=m.grant_id AND g.owner_id=m.owner_id
 WHERE h.owner_id=NEW.owner_id AND g.state='active' AND g.revision=m.grant_revision
 AND g.platform_instance=(SELECT instance_id FROM alcor_instance WHERE singleton) FOR SHARE OF g)
 THEN RAISE EXCEPTION 'new source attribution requires its active shared source grant' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_mapping_attribution_grant BEFORE INSERT ON fee_legacy_attributions FOR EACH ROW EXECUTE FUNCTION guard_legacy_mapping_attribution_grant();
