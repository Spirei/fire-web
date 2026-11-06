-- Private personal transfer archives are separate from whole-database disaster recovery.
CREATE TABLE personal_data_transfer_sources (
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,request_id uuid NOT NULL,
 origin_instance uuid NOT NULL,sha256 text NOT NULL CHECK(length(sha256)=64),
 raw bytea NOT NULL CHECK(octet_length(raw)<=10485760),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id)
);
CREATE TABLE personal_data_transfer_previews (
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,source_id uuid NOT NULL,
 request_id uuid NOT NULL,request_hash text NOT NULL,authorization_binding text NOT NULL,
 plan jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,source_id) REFERENCES personal_data_transfer_sources(owner_id,id)
);
CREATE TABLE personal_data_transfer_operations (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,request_hash text NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id)
);
CREATE TABLE personal_data_transfer_before_images (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,sha256 text NOT NULL,
 raw bytea NOT NULL CHECK(octet_length(raw)<=10485760),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER personal_transfer_source_immutable BEFORE UPDATE OR DELETE ON personal_data_transfer_sources FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER personal_transfer_receipt_immutable BEFORE UPDATE OR DELETE ON personal_data_transfer_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER personal_transfer_before_immutable BEFORE UPDATE OR DELETE ON personal_data_transfer_before_images FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
-- Imported activity is an owner's historical declaration, never a platform audit event.
CREATE TABLE personal_legacy_activities (
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,source_id uuid NOT NULL,
 original_id text NOT NULL,raw jsonb NOT NULL,content_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id),
 UNIQUE(owner_id,content_hash),FOREIGN KEY(owner_id,source_id) REFERENCES personal_data_transfer_sources(owner_id,id)
);
CREATE TRIGGER personal_legacy_activity_immutable BEFORE UPDATE OR DELETE ON personal_legacy_activities FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
-- Old pending/cancelled/expired declarations are immutable history, not live intents.
CREATE TABLE personal_order_declarations (
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,source_id uuid NOT NULL,
 original_id text NOT NULL,original_status text NOT NULL CHECK(original_status IN ('pending','cancelled','expired')),
 record_id text,account_id text,account_kind text CHECK(account_kind IN ('real','simulated')),
 raw jsonb NOT NULL,content_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,content_hash),
 FOREIGN KEY(owner_id,source_id) REFERENCES personal_data_transfer_sources(owner_id,id),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TRIGGER personal_order_declaration_immutable BEFORE UPDATE OR DELETE ON personal_order_declarations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
