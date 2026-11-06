ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK(kind IN ('system.diagnostics','backup.create','backup.verify','backup.restore'));
ALTER TABLE tasks ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';
CREATE TABLE backups (
    id uuid PRIMARY KEY REFERENCES tasks(id),
    owner_id text NOT NULL REFERENCES users(id),
    source_instance uuid NOT NULL,
    software_version text NOT NULL,
    bytes bigint NOT NULL CHECK(bytes>0),
    sha256 text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    verified_at timestamptz
);
CREATE TABLE restore_quarantine (
    category text PRIMARY KEY,
    payload jsonb NOT NULL,
    quarantined_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
