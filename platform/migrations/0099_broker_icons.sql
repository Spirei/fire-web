-- Private originals and normalized display bytes remain available after icon reset.
CREATE TABLE broker_icon_versions (
 id uuid PRIMARY KEY, owner_id text NOT NULL, account_id text NOT NULL,
 original bytea NOT NULL CHECK(octet_length(original) BETWEEN 1 AND 2097152),
 original_sha256 text NOT NULL CHECK(original_sha256 ~ '^[a-f0-9]{64}$'),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 2097152),
 content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,account_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
ALTER TABLE broker_accounts ADD COLUMN icon_version uuid;
ALTER TABLE broker_accounts ADD CONSTRAINT broker_icon_owned_version
 FOREIGN KEY(owner_id,id,icon_version) REFERENCES broker_icon_versions(owner_id,account_id,id);
CREATE FUNCTION retain_broker_icon_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'broker icon versions are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER broker_icon_immutable BEFORE UPDATE OR DELETE ON broker_icon_versions
 FOR EACH ROW EXECUTE FUNCTION retain_broker_icon_version();
