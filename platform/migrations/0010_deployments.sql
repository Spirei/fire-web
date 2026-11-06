CREATE TABLE deployment_requests (
    id uuid PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    image text NOT NULL,
    version text NOT NULL,
    revision text NOT NULL,
    schema_hash text NOT NULL,
    status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','unknown','cancelled')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claimed_at timestamptz,
    finished_at timestamptz,
    UNIQUE(owner_id,request_id)
);
CREATE UNIQUE INDEX deployment_one_active ON deployment_requests ((true)) WHERE status IN ('queued','running');
CREATE TABLE deployment_runner (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE deployment_builds (
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('dispatching','submitted','unknown','failed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(owner_id,request_id)
);
