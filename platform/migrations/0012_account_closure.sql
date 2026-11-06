-- Retain identity tombstones for audit/financial ownership; never reuse identifiers.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;

-- Preserve source UIDs where present; new accounts inherit their immutable ID.
ALTER TABLE users ADD COLUMN uid text;
UPDATE users u SET uid=COALESCE(NULLIF(m.metadata->>'uid',''),u.id)
FROM identity_source_profiles m WHERE m.user_id=u.id;
UPDATE users SET uid=id WHERE uid IS NULL;
ALTER TABLE users ALTER COLUMN uid SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_uid_unique UNIQUE(uid);
CREATE FUNCTION initialize_user_uid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.uid IS NULL THEN NEW.uid := NEW.id; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER users_initialize_uid BEFORE INSERT ON users
FOR EACH ROW EXECUTE FUNCTION initialize_user_uid();
CREATE FUNCTION preserve_imported_user_uid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_uid text;
BEGIN
    source_uid := NULLIF(NEW.metadata->>'uid','');
    IF source_uid IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND uid NOT IN (id,source_uid)) THEN
            RAISE EXCEPTION 'Account UID is immutable';
        END IF;
        UPDATE users SET uid=source_uid WHERE id=NEW.user_id AND uid=id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER identity_source_uid AFTER INSERT OR UPDATE OF metadata ON identity_source_profiles
FOR EACH ROW EXECUTE FUNCTION preserve_imported_user_uid();
