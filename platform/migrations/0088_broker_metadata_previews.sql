-- Directory previews share existing account authority and durable operation receipts.
CREATE TABLE broker_metadata_previews (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL, request_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('create','update','delete')), account_id text NOT NULL,
 payload jsonb NOT NULL, fingerprint text NOT NULL, authorization_binding text NOT NULL,
 collection_revision bigint NOT NULL CHECK(collection_revision>=0),
 record_collection_revision bigint NOT NULL CHECK(record_collection_revision>=0),
 account_dependency text NOT NULL, expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,id)
);
CREATE INDEX broker_metadata_preview_request ON broker_metadata_previews(owner_id,request_id);
CREATE TRIGGER broker_metadata_preview_no_rewrite BEFORE UPDATE ON broker_metadata_previews
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
