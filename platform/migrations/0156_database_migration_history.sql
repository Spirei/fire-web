-- Historical registrations remain separate from newly posted economic events.
DO $$ DECLARE prior text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 IF prior IS NULL THEN RAISE EXCEPTION 'Task kind contract is missing'; END IF;
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||prior||') OR kind=''database.migration.history'')';
END $$;
CREATE TABLE database_migration_history_imports (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,task_id uuid NOT NULL REFERENCES tasks(id),
 portfolio_task_id uuid NOT NULL REFERENCES tasks(id),conversion_id uuid NOT NULL REFERENCES tasks(id),
 source_instance text NOT NULL,source_owner text NOT NULL,source_sha256 text NOT NULL,
 fingerprint text NOT NULL,originals jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),
 UNIQUE(owner_id,source_instance,source_owner),UNIQUE(task_id)
);
CREATE TRIGGER migration_history_immutable BEFORE UPDATE OR DELETE ON database_migration_history_imports
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
