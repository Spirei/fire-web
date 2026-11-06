-- Public material access only; owner files retain their separate authorities.
CREATE TABLE asset_library_access (
 singleton boolean PRIMARY KEY CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740990),
 registered boolean NOT NULL DEFAULT true,
 guest boolean NOT NULL DEFAULT true,
 CHECK(NOT guest OR registered)
);
INSERT INTO asset_library_access(singleton) VALUES(true);
CREATE TABLE asset_library_access_operations (
 actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id)
);
CREATE TRIGGER asset_library_access_operation_immutable BEFORE UPDATE OR DELETE ON asset_library_access_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
