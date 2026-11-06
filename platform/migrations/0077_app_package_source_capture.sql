CREATE TABLE app_package_source_imports (
 original_id uuid PRIMARY KEY,
 actor_id text NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 source_alias text NOT NULL CHECK(source_alias ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
 source_physical text NOT NULL CHECK(source_physical ~ '^[a-f0-9]{64}$'),
 source_file_dev bigint NOT NULL,
 source_file_ino bigint NOT NULL,
 byte_length bigint NOT NULL CHECK(byte_length BETWEEN 1 AND 2147483648),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 object_id uuid NOT NULL REFERENCES app_package_objects(id),
 source_created_at text NOT NULL CHECK(length(source_created_at) BETWEEN 20 AND 64),
 historical_uploader_verified boolean NOT NULL DEFAULT false CHECK(historical_uploader_verified = false),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,request_id),
 UNIQUE(source_physical,source_file_dev,source_file_ino)
);
CREATE TRIGGER immutable_app_package_source_import BEFORE UPDATE OR DELETE ON app_package_source_imports
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
