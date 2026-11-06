-- Owner declarations identify valuation units; they never rewrite records or broker facts.
CREATE TABLE asset_instrument_versions(
 owner_id text NOT NULL, record_id text NOT NULL, id uuid NOT NULL, request_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 record_revision bigint NOT NULL, market text NOT NULL, code text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('cash_equity','etf','unknown')),
 listing_status text NOT NULL CHECK(listing_status IN ('listed','delisted','unknown')),
 previous_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,record_id,id),UNIQUE(owner_id,record_id,revision),UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,previous_id) REFERENCES asset_instrument_versions(owner_id,id)
);
CREATE TRIGGER immutable_asset_instrument_versions BEFORE UPDATE OR DELETE ON asset_instrument_versions
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE asset_instrument_heads(
 owner_id text NOT NULL,record_id text NOT NULL,version_id uuid NOT NULL,
 PRIMARY KEY(owner_id,record_id),FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,record_id,version_id) REFERENCES asset_instrument_versions(owner_id,record_id,id)
);
CREATE TABLE asset_instrument_operations(
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
 fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER immutable_asset_instrument_operations BEFORE UPDATE OR DELETE ON asset_instrument_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE FUNCTION check_asset_instrument_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p portfolio_records; previous asset_instrument_versions;
BEGIN
 SELECT * INTO p FROM portfolio_records WHERE owner_id=NEW.owner_id AND id=NEW.record_id;
 SELECT v.* INTO previous FROM asset_instrument_heads h JOIN asset_instrument_versions v ON v.owner_id=h.owner_id AND v.id=h.version_id WHERE h.owner_id=NEW.owner_id AND h.record_id=NEW.record_id;
 IF p.id IS NULL OR p.deleted_at IS NOT NULL OR p.revision<>NEW.record_revision OR p.market<>NEW.market OR p.code<>NEW.code
 OR NEW.previous_id IS DISTINCT FROM previous.id OR NEW.revision<>coalesce(previous.revision,0)+1 THEN
  RAISE EXCEPTION 'instrument declaration requires exact owner record identity and prior version' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_instrument_version_source BEFORE INSERT ON asset_instrument_versions FOR EACH ROW EXECUTE FUNCTION check_asset_instrument_version();
ALTER TABLE asset_instrument_versions ADD FOREIGN KEY(owner_id,request_id) REFERENCES asset_instrument_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED;
