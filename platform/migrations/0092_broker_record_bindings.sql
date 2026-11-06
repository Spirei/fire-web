-- Empty, verified records may acquire explicit account ownership without rewriting financial history.
CREATE TABLE broker_binding_previews (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL, request_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('bind','unbind')), account_id text NOT NULL,
 account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
 payload jsonb NOT NULL, fingerprint text NOT NULL, authorization_binding text NOT NULL,
 collection_revision bigint NOT NULL, record_collection_revision bigint NOT NULL,
 plan jsonb NOT NULL, plan_fingerprint text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE INDEX broker_binding_preview_request ON broker_binding_previews(owner_id,request_id);
CREATE TRIGGER broker_binding_preview_no_rewrite BEFORE UPDATE ON broker_binding_previews
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE broker_record_scope_claims (
 owner_id text NOT NULL, record_id text NOT NULL,
 account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
 first_account_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,record_id), FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,first_account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TRIGGER broker_record_scope_no_rewrite BEFORE UPDATE OR DELETE ON broker_record_scope_claims
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
-- Bind only from an already explicit owned account ID; unknown kinds remain unknown.
INSERT INTO broker_record_scope_claims(owner_id,record_id,account_kind,first_account_id)
 SELECT r.owner_id,r.id,b.account_kind,b.id FROM portfolio_records r
 JOIN broker_accounts b ON b.owner_id=r.owner_id AND b.id=r.broker_account_id
 WHERE b.account_kind IN ('real','simulated');
CREATE FUNCTION guard_broker_record_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind_arg text; claimed text; old_kind text;
BEGIN
 IF NEW.broker_account_id IS NULL THEN RETURN NEW; END IF;
 SELECT account_kind INTO kind_arg FROM broker_accounts WHERE owner_id=NEW.owner_id AND id=NEW.broker_account_id;
 SELECT account_kind INTO claimed FROM broker_record_scope_claims WHERE owner_id=NEW.owner_id AND record_id=NEW.id;
 IF TG_OP='UPDATE' THEN
  IF OLD.broker_account_id IS NOT NULL AND OLD.broker_account_id IS DISTINCT FROM NEW.broker_account_id THEN
   SELECT account_kind INTO old_kind FROM broker_accounts WHERE owner_id=OLD.owner_id AND id=OLD.broker_account_id;
   IF old_kind IS DISTINCT FROM kind_arg THEN RAISE EXCEPTION 'record book scope requires explicit reconciliation' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF claimed IS NOT NULL AND claimed IS DISTINCT FROM kind_arg THEN
  RAISE EXCEPTION 'record book scope is immutable through metadata' USING ERRCODE='23514';
 END IF;
 IF claimed IS NULL AND kind_arg IN ('real','simulated') THEN
  INSERT INTO broker_record_scope_claims(owner_id,record_id,account_kind,first_account_id) VALUES(NEW.owner_id,NEW.id,kind_arg,NEW.broker_account_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broker_record_scope_guard AFTER INSERT OR UPDATE OF broker_account_id ON portfolio_records
 FOR EACH ROW EXECUTE FUNCTION guard_broker_record_scope();
