-- One request cannot post cash and a separate trade or instrument declaration.
-- Legacy broker cash commands share the account UUID namespace, too.
ALTER TABLE broker_request_domains DROP CONSTRAINT broker_request_domains_domain_check;
ALTER TABLE broker_request_domains ADD CONSTRAINT broker_request_domains_domain_check
 CHECK(domain IN ('account','source','import','preview','transfer','asset'));
CREATE TABLE asset_request_domains (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 domain text NOT NULL CHECK(domain IN ('cash','trade','fund','instrument')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER asset_request_domain_retained BEFORE UPDATE OR DELETE ON asset_request_domains
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();

CREATE FUNCTION fund_cash_receipt_pair(owner_arg text,request_arg uuid,result_arg jsonb)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM cash_ledger_operations c WHERE c.owner_id=owner_arg AND c.request_id=request_arg
 AND ((c.result->>'state'='closed' AND c.result->>'executed'='false'
       AND result_arg->>'state'='closed' AND result_arg->>'executed'='false')
  OR (c.result->>'state'='completed' AND result_arg->>'state'='completed'
      AND c.result->>'noop'='true' AND result_arg->>'noop'='true'
      AND c.result->>'executed'='false' AND result_arg->>'executed'='false'
      AND coalesce(c.result->>'entryId','')='' AND coalesce(result_arg->>'entryId','')='')
  OR (c.result->>'entryId'=result_arg->>'entryId' AND EXISTS(
   SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=owner_arg AND e.request_id=request_arg
    AND e.id::text=result_arg->>'entryId' AND (
     EXISTS(SELECT 1 FROM fund_sources s WHERE s.owner_id=owner_arg AND s.request_id=request_arg AND s.cash_entry_id=e.id)
     OR EXISTS(SELECT 1 FROM fund_source_retirements r WHERE r.owner_id=owner_arg AND r.request_id=request_arg AND r.reversal_entry_id=e.id)
    )
  ))));
$$;
CREATE TEMP TABLE asset_request_domain_seed ON COMMIT DROP AS
 SELECT owner_id,request_id,'cash'::text AS domain FROM cash_ledger_operations
 UNION ALL SELECT owner_id,request_id,'trade' FROM trade_operations
 UNION ALL SELECT owner_id,request_id,'instrument' FROM asset_instrument_operations
 UNION ALL SELECT owner_id,request_id,'fund' FROM fund_source_operations f
 WHERE NOT fund_cash_receipt_pair(f.owner_id,f.request_id,f.result);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM asset_request_domain_seed GROUP BY owner_id,request_id HAVING count(DISTINCT domain)>1)
 THEN RAISE EXCEPTION 'existing financial UUIDs require explicit domain reconciliation' USING ERRCODE='23514'; END IF;
END $$;
INSERT INTO asset_request_domains(owner_id,request_id,domain)
 SELECT owner_id,request_id,min(domain) FROM asset_request_domain_seed GROUP BY owner_id,request_id;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM asset_request_domains a JOIN broker_request_domains b USING(owner_id,request_id)
           WHERE b.domain<>'asset')
 THEN RAISE EXCEPTION 'existing broker and asset UUIDs require explicit reconciliation' USING ERRCODE='23514'; END IF;
END $$;
INSERT INTO broker_request_domains(owner_id,request_id,domain)
 SELECT owner_id,request_id,'asset' FROM asset_request_domains ON CONFLICT(owner_id,request_id) DO NOTHING;

CREATE FUNCTION reserve_asset_request_domain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assigned text;
BEGIN
 INSERT INTO broker_request_domains(owner_id,request_id,domain) VALUES(NEW.owner_id,NEW.request_id,'asset')
 ON CONFLICT(owner_id,request_id) DO NOTHING;
 SELECT domain INTO assigned FROM broker_request_domains WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id;
 IF assigned<>'asset' THEN
  RAISE EXCEPTION 'request UUID belongs to a different broker operation'
  USING ERRCODE='23505',CONSTRAINT='broker_request_domain';
 END IF;
 INSERT INTO asset_request_domains(owner_id,request_id,domain) VALUES(NEW.owner_id,NEW.request_id,TG_ARGV[0])
 ON CONFLICT(owner_id,request_id) DO NOTHING;
 SELECT domain INTO assigned FROM asset_request_domains WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id;
 IF assigned=TG_ARGV[0] THEN RETURN NEW; END IF;
 IF TG_ARGV[0]='fund' AND assigned='cash' THEN
  IF fund_cash_receipt_pair(NEW.owner_id,NEW.request_id,NEW.result) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'request UUID belongs to a different financial operation'
 USING ERRCODE='23505',CONSTRAINT='asset_request_domain';
END $$;
CREATE TRIGGER cash_request_domain BEFORE INSERT ON cash_ledger_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_asset_request_domain('cash');
CREATE TRIGGER trade_request_domain BEFORE INSERT ON trade_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_asset_request_domain('trade');
CREATE TRIGGER fund_request_domain BEFORE INSERT ON fund_source_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_asset_request_domain('fund');
CREATE TRIGGER instrument_request_domain BEFORE INSERT ON asset_instrument_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_asset_request_domain('instrument');
