CREATE TABLE business_notification_telegram_link_operations(
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 challenge_id uuid NOT NULL, origin_instance uuid NOT NULL, principal text NOT NULL,
 session_version int NOT NULL, url_cipher text NOT NULL, expires_at timestamptz NOT NULL,
 generated boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,challenge_id) REFERENCES business_notification_challenges(owner_id,id));
CREATE TRIGGER immutable_notification_link_operation BEFORE UPDATE OR DELETE ON business_notification_telegram_link_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE business_notification_provider_probe_admissions(
 owner_id text NOT NULL, request_id uuid NOT NULL, provider_revision uuid NOT NULL,
 origin_instance uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id), FOREIGN KEY(owner_id,provider_revision)
 REFERENCES business_notification_provider_revisions(owner_id,revision));
CREATE TRIGGER immutable_notification_probe_admission BEFORE UPDATE OR DELETE ON business_notification_provider_probe_admissions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
