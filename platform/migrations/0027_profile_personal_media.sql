-- Personal fields and owner-bound immutable media extend the existing profile authority.
-- Keep user_profiles authoritative. Existing UUID revision remains the new-Web CAS.
ALTER TABLE user_profiles ADD COLUMN bio text NOT NULL DEFAULT '';
ALTER TABLE user_profiles ADD COLUMN gender text NOT NULL DEFAULT 'unspecified'
    CHECK (gender IN ('unspecified','male','female'));
ALTER TABLE user_profiles ADD COLUMN personal_revision bigint NOT NULL DEFAULT 0
    CHECK (personal_revision BETWEEN 0 AND 9007199254740991);
ALTER TABLE user_profiles ADD COLUMN initialized_fields text[] NOT NULL DEFAULT '{}'
    CHECK (initialized_fields <@ ARRAY['bio','gender','background']::text[]);
-- Background payload will live in a private immutable file, not another profile authority.
ALTER TABLE user_profiles ADD COLUMN background_object_id uuid;
ALTER TABLE user_profiles ADD COLUMN background_sha256 text
    CHECK (background_sha256 IS NULL OR background_sha256 ~ '^[0-9a-f]{64}$');
CREATE TABLE profile_operation_receipts (
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    actor_client text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('update_profile','upload_background')),
    state text NOT NULL CHECK (state IN ('completed','failed')),
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(owner_id,request_id)
);
CREATE TABLE profile_media_objects (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 media_type text NOT NULL CHECK(media_type IN ('image/jpeg','image/png','image/gif','image/webp')),
 byte_length bigint NOT NULL CHECK(byte_length BETWEEN 1 AND 8388608),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,owner_id), UNIQUE(id,sha256,owner_id)
);
ALTER TABLE user_profiles ADD CONSTRAINT profile_background_object
 FOREIGN KEY(background_object_id,background_sha256,user_id) REFERENCES profile_media_objects(id,sha256,owner_id);
ALTER TABLE user_profiles ADD CONSTRAINT profile_background_pair
 CHECK ((background_object_id IS NULL)=(background_sha256 IS NULL));
ALTER TABLE user_profiles ADD COLUMN avatar_object_id uuid;
ALTER TABLE user_profiles ADD CONSTRAINT profile_avatar_object
 FOREIGN KEY(avatar_object_id,user_id) REFERENCES profile_media_objects(id,owner_id);
