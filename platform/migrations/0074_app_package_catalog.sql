CREATE TABLE app_package_objects (
 id uuid PRIMARY KEY, actor_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 240),
 platform text NOT NULL CHECK(platform IN ('Android','iOS')),
 byte_length bigint NOT NULL CHECK(byte_length BETWEEN 1 AND 2147483648),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,request_id)
);
CREATE INDEX app_package_catalog_order ON app_package_objects(created_at DESC,id DESC);
CREATE TRIGGER immutable_app_package BEFORE UPDATE OR DELETE ON app_package_objects
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
