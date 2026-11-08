-- Migration sources are separate from the running platform's environment connection.
CREATE TABLE database_migration_source (
 singleton boolean PRIMARY KEY CHECK(singleton),
 revision uuid NOT NULL,
 config jsonb NOT NULL,
 password_ciphertext text,
 updated_by text NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE database_migration_source_operations (
 actor_id text NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id)
);
CREATE TRIGGER database_migration_source_operation_immutable BEFORE UPDATE OR DELETE ON database_migration_source_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE database_migration_connection_observations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 scope text NOT NULL CHECK(scope IN ('source','target')),
 source_revision uuid,
 runtime_binding text NOT NULL CHECK(runtime_binding ~ '^[a-f0-9]{64}$'),
 actor_id text NOT NULL REFERENCES users(id),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((scope='source')=(source_revision IS NOT NULL))
);
CREATE INDEX database_migration_observation_lookup ON database_migration_connection_observations(scope,runtime_binding,source_revision,id DESC);
CREATE TRIGGER database_migration_observation_immutable BEFORE UPDATE OR DELETE ON database_migration_connection_observations
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
