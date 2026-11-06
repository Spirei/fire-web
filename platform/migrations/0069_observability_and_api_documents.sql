CREATE TABLE api_documents (
    version smallint PRIMARY KEY CHECK (version IN (1,2)),
    content text NOT NULL CHECK (octet_length(content)<=524288),
    revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE api_document_operations (
    actor_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE request_observations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    observation_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    path text NOT NULL CHECK (length(path)<=240),
    method text NOT NULL CHECK (method IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','OTHER')),
    source text NOT NULL CHECK (source IN ('web','ios','app','other')),
    status smallint NOT NULL CHECK(status BETWEEN 100 AND 599),
    duration double precision NOT NULL CHECK(duration>=0 AND duration<=86400000)
);
CREATE INDEX request_observations_at ON request_observations(at);
CREATE TABLE request_rollup_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    revision bigint NOT NULL DEFAULT 0,
    aggregate_revision bigint NOT NULL DEFAULT 0,
    detail_floor bigint NOT NULL DEFAULT 0,
    lost bigint NOT NULL DEFAULT 0
);
INSERT INTO request_rollup_state(singleton) VALUES(true);
CREATE TABLE request_rollups (
    unit text NOT NULL CHECK(unit IN ('hour','day')),
    bucket timestamptz NOT NULL,
    path text NOT NULL,
    method text NOT NULL,
    source text NOT NULL,
    status smallint NOT NULL,
    count bigint NOT NULL,
    total_ms double precision NOT NULL,
    PRIMARY KEY(unit,bucket,path,method,source,status)
);
CREATE TABLE request_stream_leases (
    id uuid PRIMARY KEY,
    expires_at timestamptz NOT NULL
);
CREATE FUNCTION immutable_api_document_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'API document receipts are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_api_document_operation BEFORE UPDATE OR DELETE ON api_document_operations FOR EACH ROW EXECUTE FUNCTION immutable_api_document_operation();
CREATE TABLE request_observation_producers (
    id uuid PRIMARY KEY,
    lost bigint NOT NULL CHECK(lost>=0)
);
