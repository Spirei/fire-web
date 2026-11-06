CREATE TABLE connection_settings (
    kind text PRIMARY KEY CHECK (kind IN ('postgresql','redis')),
    revision uuid NOT NULL,
    config jsonb NOT NULL,
    password_ciphertext text,
    updated_by text NOT NULL REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE connection_receipts (
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('postgresql','redis')),
    operation text NOT NULL CHECK (operation IN ('test','save')),
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id, request_id)
);
CREATE TABLE connection_probes (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE connection_applied (
    process_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('api','worker')),
    kind text NOT NULL CHECK (kind IN ('postgresql','redis')),
    revision uuid NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (process_id,kind)
);
