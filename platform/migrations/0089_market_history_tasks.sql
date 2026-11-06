-- Activate the existing bounded history worker lane without changing prior task kinds.
DO $$
DECLARE previous text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous
 FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||previous||') OR kind=''market.history'')';
END $$;
