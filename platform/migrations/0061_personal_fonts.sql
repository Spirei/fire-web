-- Owner-private fonts share the existing immutable ResourceMedia and encrypted snapshot.
CREATE TABLE personal_font_scopes (
 owner_id text PRIMARY KEY REFERENCES users(id),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE personal_fonts (
 owner_id text NOT NULL REFERENCES users(id),
 id text NOT NULL CHECK(id ~ '^custom-[1-9][0-9]*-[a-f0-9]{64}\.(woff2?|ttf|otf)$'),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60 AND name !~ '[\x01-\x1f\x7f]'),
 sha256 text NOT NULL,
 byte_length bigint NOT NULL CHECK(byte_length BETWEEN 48 AND 10485760),
 extension text NOT NULL CHECK(extension IN ('woff','woff2','ttf','otf')),
 media_type text NOT NULL CHECK(media_type IN ('font/woff','font/woff2','font/ttf','font/otf')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),
 UNIQUE(owner_id,sha256,extension),
 FOREIGN KEY(owner_id,sha256) REFERENCES resource_media_objects(owner_id,sha256)
);
CREATE TABLE personal_font_operations (
 owner_id text NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id)
);
CREATE FUNCTION guard_personal_font() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE public_uid text; existing bigint;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable personal font'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('personal-fonts:'||NEW.owner_id,0));
 SELECT uid INTO public_uid FROM users WHERE id=NEW.owner_id AND active;
 IF public_uid IS NULL OR NEW.id <> 'custom-'||public_uid||'-'||NEW.sha256||'.'||NEW.extension
 OR NEW.media_type <> 'font/'||NEW.extension
 OR NOT EXISTS(SELECT 1 FROM resource_media_objects WHERE owner_id=NEW.owner_id AND sha256=NEW.sha256 AND byte_length=NEW.byte_length)
 THEN RAISE EXCEPTION 'font identity or bytes mismatch'; END IF;
 SELECT count(*) INTO existing FROM personal_fonts WHERE owner_id=NEW.owner_id;
 IF existing>=20 THEN RAISE EXCEPTION 'personal font quota exceeded'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER personal_font_guard BEFORE INSERT OR UPDATE OR DELETE ON personal_fonts FOR EACH ROW EXECUTE FUNCTION guard_personal_font();
CREATE FUNCTION guard_personal_font_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable personal font receipt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER personal_font_operation_guard BEFORE UPDATE OR DELETE ON personal_font_operations FOR EACH ROW EXECUTE FUNCTION guard_personal_font_operation();
