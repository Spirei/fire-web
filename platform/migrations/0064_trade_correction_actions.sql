-- Compatibility identifiers are new platform facts, never recovered old broker numbers.
CREATE SEQUENCE trade_presentation_number AS bigint MINVALUE 1000000000 MAXVALUE 9999999999 START 1000000000 NO CYCLE;
CREATE TABLE trade_presentation_ids (
 owner_id text NOT NULL REFERENCES users(id),target_kind text NOT NULL CHECK(target_kind IN ('trade','amendment','internal_order')),
 target_id uuid NOT NULL,number bigint NOT NULL DEFAULT nextval('trade_presentation_number') CHECK(number BETWEEN 1000000000 AND 9999999999),
 authority text NOT NULL DEFAULT 'platform_assigned' CHECK(authority='platform_assigned'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,target_kind,target_id),UNIQUE(number)
);
CREATE FUNCTION guard_trade_presentation_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.target_kind='trade' AND NOT EXISTS(SELECT 1 FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.target_id))
 OR (NEW.target_kind='amendment' AND NOT EXISTS(SELECT 1 FROM trade_amendments WHERE owner_id=NEW.owner_id AND replacement_id=NEW.target_id))
 OR (NEW.target_kind='internal_order' AND NOT EXISTS(SELECT 1 FROM internal_orders WHERE owner_id=NEW.owner_id AND id=NEW.target_id))
 THEN RAISE EXCEPTION 'platform display number requires its own actual ledger identity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_trade_presentation_id BEFORE INSERT ON trade_presentation_ids FOR EACH ROW EXECUTE FUNCTION guard_trade_presentation_id();
CREATE TRIGGER immutable_trade_presentation_id BEFORE UPDATE OR DELETE ON trade_presentation_ids FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION allocate_trade_presentation_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_arg uuid;kind_arg text;
BEGIN
 IF TG_TABLE_NAME='trade_amendments' THEN target_arg:=NEW.replacement_id;kind_arg:='amendment';
 ELSE target_arg:=NEW.id;kind_arg:=CASE TG_TABLE_NAME WHEN 'trade_ledger' THEN 'trade' ELSE 'internal_order' END; END IF;
 INSERT INTO trade_presentation_ids(owner_id,target_kind,target_id) VALUES(NEW.owner_id,kind_arg,target_arg);
 RETURN NEW;
END $$;
CREATE TRIGGER allocate_trade_display AFTER INSERT ON trade_ledger FOR EACH ROW EXECUTE FUNCTION allocate_trade_presentation_id();
CREATE TRIGGER allocate_amendment_display AFTER INSERT ON trade_amendments FOR EACH ROW EXECUTE FUNCTION allocate_trade_presentation_id();
CREATE TRIGGER allocate_internal_order_display AFTER INSERT ON internal_orders FOR EACH ROW EXECUTE FUNCTION allocate_trade_presentation_id();
INSERT INTO trade_presentation_ids(owner_id,target_kind,target_id) SELECT owner_id,'trade',id FROM trade_ledger ORDER BY created_at,id;
INSERT INTO trade_presentation_ids(owner_id,target_kind,target_id) SELECT owner_id,'amendment',replacement_id FROM trade_amendments ORDER BY created_at,id;
INSERT INTO trade_presentation_ids(owner_id,target_kind,target_id) SELECT owner_id,'internal_order',id FROM internal_orders ORDER BY created_at,id;

CREATE TABLE trade_registration_contexts (
 owner_id text NOT NULL,trade_id uuid NOT NULL,request_id uuid NOT NULL,context jsonb NOT NULL,context_raw bytea NOT NULL,context_sha256 text NOT NULL,
 authority text NOT NULL CHECK(authority='legacy_owner_declared'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,trade_id),FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(context=convert_from(context_raw,'UTF8')::jsonb AND context_sha256=encode(sha256(context_raw),'hex'))
);
CREATE FUNCTION guard_trade_registration_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original trade_ledger;
BEGIN
 SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
 IF original.id IS NULL OR original.request_id<>NEW.request_id OR original.source<>'owner_recorded'
 OR original.input_payload->'_legacyTradeContext' IS DISTINCT FROM NEW.context
 OR NEW.context->>'source' IS DISTINCT FROM 'legacy_explicit_record_request'
 OR NEW.context->>'accountId' IS DISTINCT FROM NEW.owner_id OR NEW.context->>'recordId' IS DISTINCT FROM original.record_id
 OR NEW.context->>'brokerAccountId' IS DISTINCT FROM original.account_id
 OR NEW.context->>'brokerNameAtEntry' IS DISTINCT FROM (SELECT name FROM broker_accounts WHERE owner_id=NEW.owner_id AND id=original.account_id)
 OR NEW.context->>'brokerNameSource' IS DISTINCT FROM 'platform_account_at_entry' OR NEW.context->>'requestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.context->>'orderType' IS NULL OR NEW.context->>'tif' IS NULL OR NEW.context->>'session' IS NULL
 OR NEW.context->>'mode' IS DISTINCT FROM 'record' OR NEW.context->>'orderType' NOT IN ('market','limit')
 OR NEW.context->>'tif' NOT IN ('day','gtc') OR NEW.context->>'session' NOT IN ('REGULAR','EXTENDED')
 THEN RAISE EXCEPTION 'legacy entry context must be exactly declared in the same original native registration' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_trade_registration_context BEFORE INSERT ON trade_registration_contexts FOR EACH ROW EXECUTE FUNCTION guard_trade_registration_context();
CREATE TRIGGER immutable_trade_registration_context BEFORE UPDATE OR DELETE ON trade_registration_contexts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION check_trade_registration_context_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id
 AND o.result->>'kind'='legacy_recorded_trade' AND o.result->>'state'='completed' AND o.result->>'tradeId'=NEW.trade_id::text
 AND o.result->'legacyReceipt'->>'kind'='submit_trade' AND o.result->'legacyReceipt'->>'state'='completed'
 AND o.result->'legacyReceipt'->>'requestId'=NEW.request_id::text)
 THEN RAISE EXCEPTION 'legacy entry context and old receipt view require one same-UUID atomic native registration' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_trade_registration_context_receipt AFTER INSERT ON trade_registration_contexts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_trade_registration_context_receipt();

-- A member is provenance into the existing amendment, not another position/cash book.
ALTER TABLE trade_amendments ADD COLUMN action text NOT NULL DEFAULT 'amend' CHECK(action IN ('amend','merge','delete'));
CREATE TABLE trade_correction_members (
 owner_id text NOT NULL,amendment_id uuid NOT NULL,trade_id uuid NOT NULL,previous_member_amendment_id uuid,
 disposition text NOT NULL CHECK(disposition IN ('retained','superseded','deleted')),before_event jsonb NOT NULL,target_replacement_id uuid,
 PRIMARY KEY(owner_id,amendment_id,trade_id),FOREIGN KEY(owner_id,amendment_id) REFERENCES trade_amendments(owner_id,id),
 FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),FOREIGN KEY(owner_id,previous_member_amendment_id) REFERENCES trade_amendments(owner_id,id)
);
CREATE FUNCTION guard_single_trade_correction_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_amendments a WHERE a.owner_id=NEW.owner_id AND a.id=NEW.amendment_id AND a.action='amend'
 AND a.trade_id=NEW.trade_id AND a.previous_amendment_id IS NOT DISTINCT FROM NEW.previous_member_amendment_id
 AND a.before_event=NEW.before_event AND a.replacement_id IS NOT DISTINCT FROM NEW.target_replacement_id AND NEW.disposition='retained')
 THEN RAISE EXCEPTION 'correction members must match actual immutable amendment evidence; group actions require their later full guard' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_single_trade_correction_member BEFORE INSERT ON trade_correction_members FOR EACH ROW EXECUTE FUNCTION guard_single_trade_correction_member();
CREATE TRIGGER immutable_trade_correction_member BEFORE UPDATE OR DELETE ON trade_correction_members FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
INSERT INTO trade_correction_members(owner_id,amendment_id,trade_id,previous_member_amendment_id,disposition,before_event,target_replacement_id)
 SELECT owner_id,id,trade_id,previous_amendment_id,'retained',before_event,replacement_id FROM trade_amendments;
CREATE FUNCTION bind_single_trade_correction_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action<>'amend' THEN RAISE EXCEPTION 'group correction posting is not enabled before its full atomic action guard' USING ERRCODE='23514'; END IF;
 INSERT INTO trade_correction_members(owner_id,amendment_id,trade_id,previous_member_amendment_id,disposition,before_event,target_replacement_id)
 VALUES(NEW.owner_id,NEW.id,NEW.trade_id,NEW.previous_amendment_id,'retained',NEW.before_event,NEW.replacement_id);
 RETURN NEW;
END $$;
CREATE TRIGGER bind_single_trade_correction_member AFTER INSERT ON trade_amendments FOR EACH ROW EXECUTE FUNCTION bind_single_trade_correction_member();

-- Old F10 submits do not echo a proof token. The same server-held single-use
-- native proof is resolved by current owner/session and exact semantic body.
CREATE TABLE legacy_trade_preview_bindings (
 owner_id text NOT NULL REFERENCES users(id),session_hash text NOT NULL,semantic_hash text NOT NULL,
 token_hash text PRIMARY KEY REFERENCES trade_previews(token_hash),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX legacy_trade_preview_lookup ON legacy_trade_preview_bindings(owner_id,session_hash,semantic_hash,created_at DESC);

CREATE FUNCTION guard_legacy_trade_preview_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_previews p WHERE p.token_hash=NEW.token_hash AND p.owner_id=NEW.owner_id AND p.session_hash=NEW.session_hash AND p.fingerprint=NEW.semantic_hash)
 THEN RAISE EXCEPTION 'legacy proof binding must retain its same original owner session and exact native body' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_trade_preview_binding BEFORE INSERT ON legacy_trade_preview_bindings FOR EACH ROW EXECUTE FUNCTION guard_legacy_trade_preview_binding();
CREATE TRIGGER immutable_legacy_trade_preview_binding BEFORE UPDATE ON legacy_trade_preview_bindings FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
