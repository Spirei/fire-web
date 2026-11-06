-- Aliases bind old URLs to registered immutable versions, never host paths.
CREATE TABLE media_compat_aliases(
 scope text NOT NULL CHECK(scope IN ('owner','admin','public')),owner_key text NOT NULL,legacy_path text NOT NULL,
 owner_id text REFERENCES users(id),target_kind text NOT NULL CHECK(target_kind IN ('system','attachment','resource','report')),
 target_id text NOT NULL,sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),byte_length bigint NOT NULL CHECK(byte_length>=0),
 revision bigint NOT NULL CHECK(revision>0),deleted_at timestamptz,created_by text NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope,owner_key,legacy_path),CHECK(legacy_path LIKE '/uploads/%'),
 CHECK((scope='owner' AND owner_id IS NOT NULL AND owner_id=owner_key) OR (scope IN ('admin','public') AND owner_id IS NULL AND owner_key='')),
 CHECK(target_kind<>'report' OR scope='admin'),CHECK(target_kind<>'resource' OR scope='owner')
);
CREATE TABLE media_compat_operations(actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id));
CREATE TRIGGER immutable_media_compat_operation BEFORE UPDATE OR DELETE ON media_compat_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE media_compat_versions(id uuid PRIMARY KEY,scope text NOT NULL,owner_key text NOT NULL,legacy_path text NOT NULL,revision bigint NOT NULL,payload jsonb NOT NULL,actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(scope,owner_key,legacy_path,revision));
CREATE TRIGGER immutable_media_compat_version BEFORE UPDATE OR DELETE ON media_compat_versions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
