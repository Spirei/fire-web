CREATE TABLE fire_planning_operations (
 owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 fingerprint text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id)
);

CREATE FUNCTION protect_fire_operation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'FIRE operation receipts are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER fire_operation_receipt_immutable BEFORE UPDATE ON fire_planning_operations
FOR EACH ROW EXECUTE FUNCTION protect_fire_operation_receipt();
