-- Confirmed official snapshots and source event archives never rewrite actual fills.
CREATE TABLE broker_statement_imports (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL, request_id uuid NOT NULL,
 account_id text NOT NULL, account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
 original_id uuid NOT NULL, preview_id uuid NOT NULL,
 source_sha256 text NOT NULL, external_account text NOT NULL,
 from_date date NOT NULL, to_date date NOT NULL CHECK(to_date>=from_date),
 statement jsonb NOT NULL, comparison jsonb NOT NULL,
 authorization_binding text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,request_id), UNIQUE(owner_id,account_id,source_sha256),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id),
 FOREIGN KEY(owner_id,original_id) REFERENCES broker_statement_originals(owner_id,id)
);
CREATE TRIGGER broker_statement_import_no_rewrite BEFORE UPDATE OR DELETE ON broker_statement_imports
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE broker_statement_events (
 owner_id text NOT NULL, account_id text NOT NULL, account_kind text NOT NULL,
 external_id text NOT NULL, first_import_id uuid NOT NULL, payload jsonb NOT NULL, payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,account_id,external_id),
 FOREIGN KEY(owner_id,first_import_id) REFERENCES broker_statement_imports(owner_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TRIGGER broker_statement_event_no_rewrite BEFORE UPDATE OR DELETE ON broker_statement_events
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE broker_statement_import_operations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 request_hash text, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER broker_statement_import_receipt_no_rewrite BEFORE UPDATE OR DELETE ON broker_statement_import_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
ALTER TABLE broker_statement_imports ADD CONSTRAINT broker_statement_preview_once UNIQUE(owner_id,preview_id);
CREATE TABLE broker_statement_positions (
 owner_id text NOT NULL, import_id uuid NOT NULL, account_id text NOT NULL, record_id text NOT NULL,
 quantity numeric NOT NULL CHECK(quantity>=0), cost numeric, price numeric CHECK(price IS NULL OR price>=0),
 source_absent boolean NOT NULL, PRIMARY KEY(owner_id,import_id,record_id),
 FOREIGN KEY(owner_id,import_id) REFERENCES broker_statement_imports(owner_id,id),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TRIGGER broker_statement_position_no_rewrite BEFORE UPDATE OR DELETE ON broker_statement_positions
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE FUNCTION guard_broker_statement_import() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p broker_statement_previews; o broker_statement_originals; a broker_accounts;
BEGIN
 SELECT * INTO p FROM broker_statement_previews WHERE owner_id=NEW.owner_id AND id=NEW.preview_id;
 SELECT * INTO o FROM broker_statement_originals WHERE owner_id=NEW.owner_id AND id=NEW.original_id;
 SELECT * INTO a FROM broker_accounts WHERE owner_id=NEW.owner_id AND id=NEW.account_id;
 IF p.id IS NULL OR o.id IS NULL OR a.id IS NULL OR a.deleted_at IS NOT NULL
 OR p.expires_at<=clock_timestamp() OR p.original_id<>NEW.original_id OR p.account_id<>NEW.account_id
 OR p.account_kind<>NEW.account_kind OR a.account_kind<>NEW.account_kind OR p.account_revision<>a.revision
 OR p.authorization_binding<>NEW.authorization_binding OR p.parsed IS DISTINCT FROM NEW.statement
 OR p.comparison IS DISTINCT FROM NEW.comparison OR o.account_id<>NEW.account_id OR o.account_kind<>NEW.account_kind
 OR o.external_account<>NEW.external_account OR o.source_sha256<>NEW.source_sha256
 OR encode(sha256(o.source_bytes),'hex')<>NEW.source_sha256
 OR to_char(NEW.from_date,'YYYYMMDD') IS DISTINCT FROM NEW.statement->>'fromDate'
 OR to_char(NEW.to_date,'YYYYMMDD') IS DISTINCT FROM NEW.statement->>'toDate'
 OR NEW.statement->>'externalAccount'<>NEW.external_account OR NEW.statement->>'sourceSha256'<>NEW.source_sha256
 THEN RAISE EXCEPTION 'statement import requires exact current owned preview and original' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broker_statement_import_guard BEFORE INSERT ON broker_statement_imports
 FOR EACH ROW EXECUTE FUNCTION guard_broker_statement_import();
CREATE FUNCTION guard_broker_statement_position() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i broker_statement_imports; r portfolio_records; observed jsonb;
BEGIN
 SELECT * INTO i FROM broker_statement_imports WHERE owner_id=NEW.owner_id AND id=NEW.import_id;
 SELECT * INTO r FROM portfolio_records WHERE owner_id=NEW.owner_id AND id=NEW.record_id;
 IF i.id IS NULL OR r.id IS NULL OR r.deleted_at IS NOT NULL OR i.account_id<>NEW.account_id
 OR r.broker_account_id IS DISTINCT FROM NEW.account_id
 THEN RAISE EXCEPTION 'statement position owner/account mismatch' USING ERRCODE='23514'; END IF;
 SELECT value INTO observed FROM jsonb_array_elements(i.statement->'positions') WHERE value->>'key'=r.market||':'||r.code;
 IF observed IS NULL THEN
  IF NOT NEW.source_absent OR NEW.quantity<>0 OR NEW.cost IS NOT NULL OR NEW.price IS NOT NULL
  THEN RAISE EXCEPTION 'absent source position must be explicit zero without invented price/cost' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_absent OR NEW.quantity IS DISTINCT FROM (observed->>'qty')::numeric
 OR NEW.cost IS DISTINCT FROM (observed->>'cost')::numeric OR NEW.price IS DISTINCT FROM (observed->>'price')::numeric
 THEN RAISE EXCEPTION 'statement position must equal original observation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broker_statement_position_guard BEFORE INSERT ON broker_statement_positions
 FOR EACH ROW EXECUTE FUNCTION guard_broker_statement_position();
CREATE FUNCTION guard_broker_statement_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM broker_statement_imports i CROSS JOIN LATERAL jsonb_array_elements(i.statement->'events') e
 WHERE i.owner_id=NEW.owner_id AND i.id=NEW.first_import_id AND i.account_id=NEW.account_id
 AND i.account_kind=NEW.account_kind AND e->>'id'=NEW.external_id AND e=NEW.payload)
 THEN RAISE EXCEPTION 'statement event must belong to retained original import' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broker_statement_event_guard BEFORE INSERT ON broker_statement_events
 FOR EACH ROW EXECUTE FUNCTION guard_broker_statement_event();
