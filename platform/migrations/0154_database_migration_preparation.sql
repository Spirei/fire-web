DO $$ DECLARE prior text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 IF prior IS NULL THEN RAISE EXCEPTION 'Task kind contract is missing'; END IF;
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||prior||') OR kind=''database.migration.prepare'')';
END $$;
