CREATE TABLE legacy_flat_order_operations(owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
 fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id));
CREATE TRIGGER immutable_flat_order_operation BEFORE UPDATE OR DELETE ON legacy_flat_order_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE legacy_order_import_sources(owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,
 filename text NOT NULL,sha256 text NOT NULL,raw bytea NOT NULL CHECK(octet_length(raw)<=16777216),rows jsonb NOT NULL,
 principal text NOT NULL,origin_instance uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id));
CREATE TRIGGER immutable_order_import_source BEFORE UPDATE OR DELETE ON legacy_order_import_sources FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE legacy_order_import_previews(owner_id text NOT NULL,id uuid NOT NULL,source_id uuid NOT NULL,
 snapshot_revision text NOT NULL,mappings jsonb NOT NULL,result jsonb NOT NULL,principal text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,source_id) REFERENCES legacy_order_import_sources(owner_id,id));
CREATE TRIGGER immutable_order_import_preview BEFORE UPDATE OR DELETE ON legacy_order_import_previews FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE legacy_order_import_operations(owner_id text NOT NULL,request_id uuid NOT NULL,preview_id uuid NOT NULL,
 fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),UNIQUE(owner_id,preview_id),FOREIGN KEY(owner_id,preview_id) REFERENCES legacy_order_import_previews(owner_id,id));
CREATE TRIGGER immutable_order_import_operation BEFORE UPDATE OR DELETE ON legacy_order_import_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE legacy_order_import_links(owner_id text NOT NULL,source_id uuid NOT NULL,row_index int NOT NULL,
 content_hash text NOT NULL,request_id uuid NOT NULL,trade_id uuid NOT NULL,original_order_no text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,source_id,row_index),UNIQUE(owner_id,content_hash),
 FOREIGN KEY(owner_id,source_id) REFERENCES legacy_order_import_sources(owner_id,id),
 FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES legacy_flat_order_operations(owner_id,request_id));
CREATE TRIGGER immutable_order_import_link BEFORE UPDATE OR DELETE ON legacy_order_import_links FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
ALTER TABLE asset_request_domains DROP CONSTRAINT asset_request_domains_domain_check;
ALTER TABLE asset_request_domains ADD CONSTRAINT asset_request_domains_domain_check
 CHECK(domain IN ('cash','trade','fund','instrument','internal_order','legacy_flat_order','legacy_order_import'));
CREATE TRIGGER flat_order_request_domain BEFORE INSERT ON legacy_flat_order_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_asset_request_domain('legacy_flat_order');
CREATE TRIGGER order_import_request_domain BEFORE INSERT ON legacy_order_import_operations
 FOR EACH ROW EXECUTE FUNCTION reserve_asset_request_domain('legacy_order_import');
