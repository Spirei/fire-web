CREATE TABLE fire_app_packages (
    id uuid PRIMARY KEY,
    request_id uuid NOT NULL,
    uploaded_by text REFERENCES users(id) ON DELETE SET NULL,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
    platform text NOT NULL CHECK (platform IN ('Android','iOS')),
    byte_length bigint NOT NULL CHECK (byte_length BETWEEN 4 AND 2147483648),
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(uploaded_by, request_id)
);
