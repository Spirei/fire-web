CREATE TABLE identity_security (
 user_id text PRIMARY KEY REFERENCES users(id),
 totp_enabled boolean NOT NULL DEFAULT false,
 totp_secret_ciphertext text,
 totp_last_step bigint NOT NULL DEFAULT -1,
 backup_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
 backup_key_ciphertext text,
 device_name text NOT NULL DEFAULT '',
 source_stamp text,
 email_verified boolean NOT NULL DEFAULT false
);
CREATE TABLE identity_passkey_config (
 singleton boolean PRIMARY KEY CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 origin text NOT NULL DEFAULT '',
 rp_id text NOT NULL DEFAULT '',
 name text NOT NULL DEFAULT 'Alcor',
 revision text NOT NULL DEFAULT ''
);
INSERT INTO identity_passkey_config(singleton) VALUES(true);
CREATE TABLE identity_passkeys (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 user_handle text NOT NULL,
 rp_id text NOT NULL,
 public_key bytea NOT NULL,
 counter bigint NOT NULL CHECK(counter >= 0),
 transports jsonb NOT NULL DEFAULT '[]'::jsonb,
 name text NOT NULL,
 backed_up boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_used_at timestamptz
);
CREATE INDEX identity_passkeys_user ON identity_passkeys(user_id);
CREATE TABLE identity_challenges (
 id text PRIMARY KEY,
 purpose text NOT NULL,
 user_id text REFERENCES users(id),
 binding text NOT NULL,
 payload jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL
);
CREATE INDEX identity_challenges_expiry ON identity_challenges(expires_at);
CREATE TABLE identity_migrations (
 fingerprint text PRIMARY KEY,
 source_origin text NOT NULL,
 user_count integer NOT NULL,
 key_count integer NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'password';
ALTER TABLE sessions ADD COLUMN passkey_id text;

CREATE TABLE identity_source_profiles (
 user_id text PRIMARY KEY REFERENCES users(id),
 metadata jsonb NOT NULL
);
CREATE TABLE identity_app_grants (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 client_id text NOT NULL CHECK(client_id='fire-ios'),
 scope text NOT NULL,
 device_name text NOT NULL,
 security_stamp text NOT NULL,
 session_version integer NOT NULL,
 passkey_id text,
 created_at timestamptz NOT NULL,
 last_used_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz
);
CREATE INDEX identity_app_grants_user ON identity_app_grants(user_id);
CREATE TABLE identity_app_access_tokens (
 token_hash text PRIMARY KEY,
 grant_id text NOT NULL REFERENCES identity_app_grants(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE identity_app_refresh_tokens (
 token_hash text PRIMARY KEY,
 grant_id text NOT NULL REFERENCES identity_app_grants(id) ON DELETE CASCADE,
 used_at timestamptz
);
CREATE TABLE identity_app_consents (
 user_id text NOT NULL REFERENCES users(id),
 client_id text NOT NULL CHECK(client_id='fire-ios'),
 scope text NOT NULL,
 security_stamp text NOT NULL,
 revision text NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,client_id)
);
ALTER TABLE sessions DROP CONSTRAINT sessions_client_id_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_client_id_check CHECK(client_id IN ('new-web','legacy-web'));
