-- Follows NEXT_price_alerts.sql, no formal version assigned.
CREATE TABLE business_notification_security_proofs(id uuid PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),
 principal text NOT NULL,operation_mac text NOT NULL,identity_stamp text NOT NULL,
 expires_at timestamptz NOT NULL,used_at timestamptz);
CREATE TABLE business_notification_provider_revisions(owner_id text NOT NULL REFERENCES users(id),revision uuid NOT NULL,
 request_id uuid NOT NULL,channel text NOT NULL,target_id text NOT NULL,target_fingerprint text NOT NULL,
 previous_revision uuid,config_stamp text NOT NULL,credential_instance uuid NOT NULL,ciphertext text NOT NULL,
 operation_mac text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,revision),UNIQUE(owner_id,request_id),FOREIGN KEY(owner_id,previous_revision) REFERENCES business_notification_provider_revisions(owner_id,revision));
CREATE TRIGGER immutable_business_notification_provider BEFORE UPDATE OR DELETE ON business_notification_provider_revisions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE business_notification_provider_revocations(owner_id text NOT NULL,provider_revision uuid NOT NULL,request_id uuid NOT NULL,
 operation_mac text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,provider_revision),UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,provider_revision) REFERENCES business_notification_provider_revisions(owner_id,revision));
CREATE TRIGGER immutable_business_notification_provider_revocation BEFORE UPDATE OR DELETE ON business_notification_provider_revocations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE business_notification_provider_checks(owner_id text NOT NULL,request_id uuid NOT NULL,provider_revision uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('verified','failed','unknown')),identity jsonb NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,provider_revision) REFERENCES business_notification_provider_revisions(owner_id,revision));
CREATE TRIGGER immutable_business_notification_provider_check BEFORE UPDATE OR DELETE ON business_notification_provider_checks FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE business_notification_challenges(owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,channel text NOT NULL,
 provider_revision uuid NOT NULL,principal text NOT NULL,native_grant_id text,session_version int NOT NULL,
 recipient_cipher text NOT NULL DEFAULT '',code_cipher text,code_mac text,token_mac text,
 expires_at timestamptz NOT NULL,attempts int NOT NULL DEFAULT 0,
 state text NOT NULL CHECK(state IN ('queued','sending','accepted','unknown','failed','locked','expired','received','confirmed','cancelled')),
 event_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),incoming_id uuid,
 PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,provider_revision) REFERENCES business_notification_provider_revisions(owner_id,revision),
 FOREIGN KEY(owner_id,event_id) REFERENCES business_notification_events(owner_id,id));
CREATE TABLE business_notification_incoming(owner_id text NOT NULL,id uuid NOT NULL,provider_revision uuid NOT NULL,
 external_id text NOT NULL,raw_ciphertext text NOT NULL,raw_sha256 text NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,provider_revision,external_id),
 FOREIGN KEY(owner_id,provider_revision) REFERENCES business_notification_provider_revisions(owner_id,revision));
CREATE TRIGGER immutable_business_notification_incoming BEFORE UPDATE OR DELETE ON business_notification_incoming FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE business_notification_provider_offsets(owner_id text NOT NULL,provider_revision uuid NOT NULL,next_offset bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(owner_id,provider_revision),FOREIGN KEY(owner_id,provider_revision) REFERENCES business_notification_provider_revisions(owner_id,revision));
CREATE UNIQUE INDEX business_notification_challenge_token ON business_notification_challenges(token_mac) WHERE token_mac IS NOT NULL;
CREATE TABLE business_notification_telegram_state(bot_id text NOT NULL,origin_instance uuid NOT NULL,next_offset bigint NOT NULL DEFAULT 0,
 lease_owner uuid,lease_version bigint NOT NULL DEFAULT 0,lease_until timestamptz,PRIMARY KEY(bot_id,origin_instance));
CREATE TABLE business_notification_telegram_pages(id uuid PRIMARY KEY,bot_id text NOT NULL,provider_owner text NOT NULL,
 provider_revision uuid NOT NULL,raw_ciphertext text NOT NULL,raw_sha256 text NOT NULL,representation text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(provider_owner,provider_revision) REFERENCES business_notification_provider_revisions(owner_id,revision));
CREATE TRIGGER immutable_business_notification_telegram_page BEFORE UPDATE OR DELETE ON business_notification_telegram_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
ALTER TABLE business_notification_incoming ADD COLUMN page_id uuid REFERENCES business_notification_telegram_pages(id),ADD COLUMN json_pointer text;
ALTER TABLE business_notification_bindings ADD COLUMN provider_revision uuid,
 ADD COLUMN principal text,ADD COLUMN native_grant_id text,ADD COLUMN session_version integer,
 ADD FOREIGN KEY(owner_id,provider_revision) REFERENCES business_notification_provider_revisions(owner_id,revision);
