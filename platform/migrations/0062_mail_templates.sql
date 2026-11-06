CREATE TABLE mail_template_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 templates jsonb NOT NULL CHECK(jsonb_typeof(templates)='array'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE mail_template_operations (
 actor_id text NOT NULL, request_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id)
);
CREATE FUNCTION immutable_mail_template_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Mail template receipts are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_mail_template_receipt BEFORE UPDATE OR DELETE ON mail_template_operations FOR EACH ROW EXECUTE FUNCTION immutable_mail_template_receipt();
