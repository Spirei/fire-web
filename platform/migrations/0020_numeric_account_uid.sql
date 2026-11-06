-- Public numeric UID is separate from the stable identity/financial ownership key.
DROP TRIGGER users_initialize_uid ON users;
DROP TRIGGER identity_source_uid ON identity_source_profiles;
DROP FUNCTION preserve_imported_user_uid();
ALTER TABLE users ADD COLUMN is_test boolean NOT NULL DEFAULT false;
UPDATE users u SET is_test=COALESCE(m.metadata->'is_test'='true'::jsonb,false)
FROM identity_source_profiles m WHERE m.user_id=u.id;
ALTER TABLE users ALTER COLUMN uid DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT users_uid_unique;
UPDATE users SET uid=NULL;
WITH numbered AS (
    SELECT id,row_number() OVER (ORDER BY created_at,id)::text AS number
    FROM users WHERE NOT is_test
)
UPDATE users u SET uid=n.number FROM numbered n WHERE u.id=n.id;
ALTER TABLE users ADD CONSTRAINT users_uid_unique UNIQUE(uid);
ALTER TABLE users ADD CONSTRAINT users_uid_kind CHECK (
    (is_test AND uid IS NULL) OR (NOT is_test AND uid IS NOT NULL AND uid ~ '^[1-9][0-9]*$')
);
CREATE TABLE account_uid_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    last_uid bigint NOT NULL CHECK(last_uid>=0)
);
INSERT INTO account_uid_state(singleton,last_uid)
SELECT true,COALESCE(max(uid::bigint),0) FROM users WHERE NOT is_test;
CREATE OR REPLACE FUNCTION initialize_user_uid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_test THEN NEW.uid:=NULL;
    ELSE
        UPDATE account_uid_state SET last_uid=last_uid+1 WHERE singleton RETURNING last_uid::text INTO NEW.uid;
        IF NOT FOUND THEN RAISE EXCEPTION 'Account UID state is missing'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER users_initialize_uid BEFORE INSERT ON users
FOR EACH ROW EXECUTE FUNCTION initialize_user_uid();
CREATE FUNCTION protect_user_uid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.uid IS DISTINCT FROM OLD.uid OR NEW.is_test IS DISTINCT FROM OLD.is_test THEN
        RAISE EXCEPTION 'Account UID and test classification are immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER users_protect_uid BEFORE UPDATE OF uid,is_test ON users
FOR EACH ROW EXECUTE FUNCTION protect_user_uid();
