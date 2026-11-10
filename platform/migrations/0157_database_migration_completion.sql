DO $$ DECLARE prior text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 IF prior IS NULL THEN RAISE EXCEPTION 'Task kind contract is missing'; END IF;
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||prior||') OR kind=''database.migration.complete'')';
END $$;
CREATE TABLE database_migration_asset_imports (
 owner_id text NOT NULL REFERENCES users(id),source_instance text NOT NULL,source_owner text NOT NULL,
 original_id text NOT NULL,original jsonb NOT NULL,result jsonb NOT NULL,task_id uuid NOT NULL REFERENCES tasks(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,source_instance,source_owner,original_id)
);
CREATE TRIGGER migration_asset_immutable BEFORE UPDATE OR DELETE ON database_migration_asset_imports FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE database_migration_completion_imports (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,task_id uuid NOT NULL REFERENCES tasks(id),
 source_instance text NOT NULL,source_owner text NOT NULL,conversion_id uuid NOT NULL REFERENCES tasks(id),
 fingerprint text NOT NULL,before_identity_ciphertext text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),
 UNIQUE(owner_id,source_instance,source_owner),UNIQUE(task_id)
);
CREATE TRIGGER migration_completion_immutable BEFORE UPDATE OR DELETE ON database_migration_completion_imports FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE database_migration_personal_imports (
 owner_id text NOT NULL REFERENCES users(id),source_instance text NOT NULL,source_owner text NOT NULL,
 source_sha256 text NOT NULL,task_id uuid NOT NULL REFERENCES tasks(id),result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,source_instance,source_owner)
);
CREATE TRIGGER migration_personal_immutable BEFORE UPDATE OR DELETE ON database_migration_personal_imports FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
