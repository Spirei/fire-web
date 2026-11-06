CREATE TABLE record_import_sources(owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,request_id uuid NOT NULL,
 fingerprint text NOT NULL,format text NOT NULL CHECK(format IN ('image','json','xlsx')),filename text NOT NULL,
 raw bytea NOT NULL CHECK(octet_length(raw)<=16777216),sha256 text NOT NULL,principal text NOT NULL,
 origin_instance uuid NOT NULL,target_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id));
CREATE TRIGGER retain_record_import_source BEFORE UPDATE OR DELETE ON record_import_sources FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER reserve_record_import_source BEFORE INSERT ON record_import_sources FOR EACH ROW EXECUTE FUNCTION reserve_portfolio_request();
CREATE TABLE record_import_source_results(owner_id text NOT NULL,source_id uuid NOT NULL,request_id uuid NOT NULL,
 result jsonb NOT NULL,provider_raw bytea CHECK(octet_length(provider_raw)<=1000000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),UNIQUE(owner_id,source_id),
 FOREIGN KEY(owner_id,source_id) REFERENCES record_import_sources(owner_id,id));
CREATE TRIGGER retain_record_import_source_result BEFORE UPDATE OR DELETE ON record_import_source_results FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE record_import_previews(owner_id text NOT NULL,id uuid NOT NULL,source_id uuid NOT NULL,
 collection_revision bigint NOT NULL,principal text NOT NULL,plan jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,source_id) REFERENCES record_import_sources(owner_id,id));
CREATE TRIGGER retain_record_import_preview BEFORE UPDATE OR DELETE ON record_import_previews FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE record_import_operations(owner_id text NOT NULL,request_id uuid NOT NULL,preview_id uuid NOT NULL,
 fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),UNIQUE(owner_id,preview_id),FOREIGN KEY(owner_id,preview_id) REFERENCES record_import_previews(owner_id,id));
CREATE TRIGGER retain_record_import_operation BEFORE UPDATE OR DELETE ON record_import_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER reserve_record_import_operation BEFORE INSERT ON record_import_operations FOR EACH ROW EXECUTE FUNCTION reserve_portfolio_request();
CREATE TABLE record_import_links(owner_id text NOT NULL,source_id uuid NOT NULL,row_index int NOT NULL,
 original_id text,source_owner text,target_record_id text NOT NULL,child_request_id uuid NOT NULL,
 source_metadata jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,source_id,row_index),
 FOREIGN KEY(owner_id,source_id) REFERENCES record_import_sources(owner_id,id),
 FOREIGN KEY(owner_id,target_record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,child_request_id) REFERENCES portfolio_record_operations(owner_id,request_id));
CREATE TRIGGER retain_record_import_link BEFORE UPDATE OR DELETE ON record_import_links FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
