-- One owner UUID cannot authorize unrelated broker mutations in different ledgers.
CREATE TABLE broker_request_domains (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 domain text NOT NULL CHECK(domain IN ('account','source','import','preview','transfer')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER broker_request_domain_retained BEFORE UPDATE OR DELETE ON broker_request_domains
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();

CREATE TEMP TABLE broker_request_domain_seed ON COMMIT DROP AS
 SELECT owner_id,request_id,'account'::text AS domain FROM broker_account_operations
 UNION ALL SELECT owner_id,request_id,'source' FROM broker_statement_source_attempts
 UNION ALL SELECT owner_id,request_id,'import' FROM broker_statement_import_operations
 UNION ALL SELECT owner_id,request_id,'transfer' FROM broker_position_transfer_operations
 UNION ALL SELECT p.owner_id,p.request_id,'preview' FROM broker_statement_preview_operations p
 WHERE NOT EXISTS(SELECT 1 FROM broker_statement_source_attempts s
  WHERE s.owner_id=p.owner_id AND s.request_id=p.request_id AND s.kind='fetch'
  AND s.account_id=p.result->>'accountId' AND (
   EXISTS(SELECT 1 FROM broker_statement_previews v WHERE v.owner_id=s.owner_id
    AND v.id::text=p.result->>'previewId' AND v.account_id=s.account_id
    AND v.authorization_binding=s.authorization_binding)
   OR EXISTS(SELECT 1 FROM broker_statement_source_results r WHERE r.owner_id=s.owner_id
    AND r.request_id=s.request_id AND r.public_result=p.result)));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM broker_request_domain_seed GROUP BY owner_id,request_id HAVING count(DISTINCT domain)>1)
 THEN RAISE EXCEPTION 'existing broker UUIDs require explicit domain reconciliation' USING ERRCODE='23514'; END IF;
END $$;
INSERT INTO broker_request_domains(owner_id,request_id,domain)
 SELECT owner_id,request_id,min(domain) FROM broker_request_domain_seed GROUP BY owner_id,request_id;

CREATE FUNCTION reserve_broker_request_domain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assigned text;
BEGIN
 INSERT INTO broker_request_domains(owner_id,request_id,domain) VALUES(NEW.owner_id,NEW.request_id,TG_ARGV[0])
 ON CONFLICT(owner_id,request_id) DO NOTHING;
 SELECT domain INTO assigned FROM broker_request_domains WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id;
 IF assigned=TG_ARGV[0] THEN RETURN NEW; END IF;
 -- A fetched source statement produces its offline preview under the admitted parent UUID.
 -- This child has no financial effect; confirmation always needs a separate import UUID.
 IF TG_ARGV[0]='preview' AND assigned='source' THEN
  -- Other trigger rows use public_result, so parse this row shape only in this branch.
  IF EXISTS(SELECT 1 FROM broker_statement_source_attempts s
    JOIN broker_statement_previews p ON p.owner_id=s.owner_id AND p.id::text=NEW.result->>'previewId'
    WHERE s.owner_id=NEW.owner_id AND s.request_id=NEW.request_id AND s.kind='fetch'
    AND s.account_id=NEW.result->>'accountId' AND p.account_id=s.account_id
    AND p.authorization_binding=s.authorization_binding
  ) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'request UUID belongs to a different broker operation'
 USING ERRCODE='23505',CONSTRAINT='broker_request_domain';
END $$;
CREATE TRIGGER broker_account_request_domain BEFORE INSERT ON broker_account_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_broker_request_domain('account');
CREATE TRIGGER broker_source_request_domain BEFORE INSERT ON broker_statement_source_attempts
 FOR EACH ROW EXECUTE FUNCTION reserve_broker_request_domain('source');
CREATE TRIGGER broker_import_request_domain BEFORE INSERT ON broker_statement_import_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_broker_request_domain('import');
CREATE TRIGGER broker_preview_request_domain BEFORE INSERT ON broker_statement_preview_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_broker_request_domain('preview');
CREATE TRIGGER broker_transfer_request_domain BEFORE INSERT ON broker_position_transfer_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_broker_request_domain('transfer');
