-- Candidate only. No formal number. Same PG tasks; shared business notifications.
CREATE TABLE price_alert_collections(owner_id text PRIMARY KEY REFERENCES users(id),revision bigint NOT NULL DEFAULT 0,channel_revision bigint NOT NULL DEFAULT 0,preferences jsonb NOT NULL DEFAULT '{"app":true}'::jsonb);
CREATE TABLE price_alert_rules(
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 account_id text NOT NULL,source_identity text NOT NULL CHECK(source_identity='platform'),
 config jsonb NOT NULL,state text NOT NULL CHECK(state IN ('enabled','paused','completed','expired','deleted')),
 activated_at timestamptz NOT NULL,last_quote_at timestamptz,deleted_at timestamptz,
 PRIMARY KEY(owner_id,id)
);
CREATE TABLE price_alert_subscriptions(
 owner_id text NOT NULL,rule_id uuid NOT NULL,principal text NOT NULL,
 native_grant_id text,session_version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,PRIMARY KEY(owner_id,rule_id,principal),
 FOREIGN KEY(owner_id,rule_id) REFERENCES price_alert_rules(owner_id,id)
);
CREATE TABLE price_alert_operations(
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER immutable_price_alert_operation BEFORE UPDATE OR DELETE ON price_alert_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE price_alert_jobs(
 task_id uuid PRIMARY KEY REFERENCES tasks(id),owner_id text NOT NULL,rule_id uuid NOT NULL,rule_revision bigint NOT NULL,
 next_scan_at timestamptz NOT NULL DEFAULT clock_timestamp(),monitoring_state text NOT NULL DEFAULT 'pending',
 FOREIGN KEY(owner_id,rule_id) REFERENCES price_alert_rules(owner_id,id),UNIQUE(owner_id,rule_id,rule_revision)
);
CREATE TABLE price_alert_quote_evidence(
 id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES tasks(id),owner_id text NOT NULL,account_id text NOT NULL,
 source_identity text NOT NULL,source_id text NOT NULL,source_version text NOT NULL,
 market text NOT NULL,code text NOT NULL,received_at timestamptz NOT NULL,
 raw_bytes bytea NOT NULL,raw_sha256 text NOT NULL,normalized jsonb NOT NULL,
 fixture boolean NOT NULL DEFAULT false
);
CREATE TABLE price_alert_worker_heartbeats(worker_id uuid PRIMARY KEY,origin_instance uuid NOT NULL,release_version text NOT NULL,
 source_fingerprint text,observed_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER immutable_price_alert_quote BEFORE UPDATE OR DELETE ON price_alert_quote_evidence FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE TABLE business_notification_events(
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,kind text NOT NULL,
 cause_key text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,cause_key)
);
CREATE TRIGGER immutable_business_notification_event BEFORE UPDATE OR DELETE ON business_notification_events FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE business_notification_reads(owner_id text NOT NULL,event_id uuid NOT NULL,read_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,event_id),FOREIGN KEY(owner_id,event_id) REFERENCES business_notification_events(owner_id,id));
CREATE TABLE business_notification_bindings(owner_id text NOT NULL REFERENCES users(id),channel text NOT NULL,
 origin_instance uuid NOT NULL,config_stamp text NOT NULL,recipient_cipher text NOT NULL,
 verified_at timestamptz,revoked_at timestamptz,PRIMARY KEY(owner_id,channel));
CREATE TABLE business_notification_deliveries(
 owner_id text NOT NULL,id uuid NOT NULL,event_id uuid NOT NULL,channel text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','sending','delivered','accepted','failed','unknown','cancelled')),
 receipt jsonb,origin_instance uuid NOT NULL,binding_fingerprint text,lease_owner uuid,lease_version bigint NOT NULL DEFAULT 0,lease_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id),UNIQUE(owner_id,event_id,channel),
 FOREIGN KEY(owner_id,event_id) REFERENCES business_notification_events(owner_id,id)
);
CREATE FUNCTION guard_business_delivery_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.owner_id,NEW.id,NEW.event_id,NEW.channel,NEW.origin_instance,NEW.binding_fingerprint)
  IS DISTINCT FROM (OLD.owner_id,OLD.id,OLD.event_id,OLD.channel,OLD.origin_instance,OLD.binding_fingerprint)
 THEN RAISE EXCEPTION 'Immutable notification delivery identity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_business_delivery_identity BEFORE UPDATE OR DELETE ON business_notification_deliveries FOR EACH ROW EXECUTE FUNCTION guard_business_delivery_identity();
CREATE TABLE business_notification_sources(owner_id text NOT NULL,domain text NOT NULL,source_id text NOT NULL,event_id uuid NOT NULL,
 PRIMARY KEY(owner_id,domain,source_id),FOREIGN KEY(owner_id,event_id) REFERENCES business_notification_events(owner_id,id));
CREATE TRIGGER immutable_business_notification_source BEFORE UPDATE OR DELETE ON business_notification_sources FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

DO $$ DECLARE existing text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO existing FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||existing||') OR kind=''alerts.monitor'')';
END $$;
