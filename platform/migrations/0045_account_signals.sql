-- Native PG committed change signals; no historical holdings or general data write lane.
CREATE TABLE account_change_metadata(singleton boolean PRIMARY KEY CHECK(singleton),
  epoch uuid NOT NULL DEFAULT gen_random_uuid(),installed_at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO account_change_metadata(singleton) VALUES(true);
CREATE TABLE account_change_revisions(owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK(domain IN ('profile','portfolio','watch','brokers','alerts','resources','feed','settings','authorization')),
  revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),changed_at timestamptz NOT NULL,
  PRIMARY KEY(owner_id,domain));
CREATE TABLE account_change_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,domain text NOT NULL,
  revision bigint NOT NULL,source_table text NOT NULL,operation text NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
  changed_at timestamptz NOT NULL,UNIQUE(owner_id,domain,revision));
CREATE TRIGGER immutable_account_change_event BEFORE UPDATE ON account_change_events
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE account_change_sources(domain text NOT NULL,source_table text NOT NULL,
  owner_column text NOT NULL,selected_columns text NOT NULL,ignored_columns text NOT NULL,
  PRIMARY KEY(domain,source_table));
INSERT INTO account_change_sources VALUES
('profile','users','id','username,email,uid,is_test',''),
('profile','user_profiles','user_id','',''),
('portfolio','portfolio_records','owner_id','',''),
('portfolio','trade_ledger','owner_id','',''),
('portfolio','cash_ledger_accounts','owner_id','',''),
('portfolio','cash_ledger_entries','owner_id','',''),
('portfolio','internal_orders','owner_id','',''),
('watch','watch_groups','owner_id','',''),
('brokers','broker_accounts','owner_id','',''),
('alerts','price_alert_rules','owner_id','',''),
('alerts','price_alert_collections','owner_id','',''),
('alerts','business_notification_events','owner_id','',''),
('alerts','business_notification_reads','owner_id','',''),
('resources','resource_files','owner_id','',''),
('resources','resource_folders','owner_id','',''),
('feed','feed_groups','owner_id','',''),
('feed','feed_posts','owner_id','',''),
('settings','account_preferences','user_id','',''),
('settings','fee_plan_heads','owner_id','',''),
('settings','fee_plan_revisions','owner_id','',''),
('authorization','users','id','role,active,session_version,password_hash',''),
('authorization','sessions','user_id','',''),
('authorization','identity_app_grants','user_id','','last_used_at'),
('authorization','identity_app_consents','user_id','',''),
('authorization','client_grants','owner_id','','last_used_at'),
('authorization','identity_passkeys','user_id','id,rp_id,public_key,user_handle',''),
('authorization','identity_security','user_id','totp_enabled,totp_secret_ciphertext,backup_codes,email_verified,source_stamp','');

CREATE FUNCTION capture_account_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous jsonb; current jsonb; compared_previous jsonb; compared_current jsonb;
  owner_value text; old_owner text; new_owner text; number bigint; changed timestamptz;
BEGIN
  IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN current:=to_jsonb(NEW); END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_ARGV[2]<>'' THEN
      SELECT jsonb_object_agg(key,value) INTO compared_previous FROM jsonb_each(previous) WHERE key=ANY(string_to_array(TG_ARGV[2],','));
      SELECT jsonb_object_agg(key,value) INTO compared_current FROM jsonb_each(current) WHERE key=ANY(string_to_array(TG_ARGV[2],','));
    ELSE
      compared_previous:=previous-string_to_array(TG_ARGV[3],',');
      compared_current:=current-string_to_array(TG_ARGV[3],',');
    END IF;
    IF compared_previous IS NOT DISTINCT FROM compared_current THEN RETURN NULL; END IF;
  END IF;
  old_owner:=previous->>TG_ARGV[1];new_owner:=current->>TG_ARGV[1];
  FOR owner_value IN SELECT DISTINCT value FROM unnest(ARRAY[old_owner,new_owner]) value WHERE value IS NOT NULL LOOP
    IF EXISTS(SELECT 1 FROM users WHERE id=owner_value) THEN
      changed:=clock_timestamp();
      INSERT INTO account_change_revisions(owner_id,domain,revision,changed_at) VALUES(owner_value,TG_ARGV[0],1,changed)
      ON CONFLICT(owner_id,domain) DO UPDATE SET revision=account_change_revisions.revision+1,changed_at=excluded.changed_at
      RETURNING revision INTO number;
      INSERT INTO account_change_events(owner_id,domain,revision,source_table,operation,changed_at)
      VALUES(owner_value,TG_ARGV[0],number,TG_TABLE_NAME,TG_OP,changed);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
DO $$ DECLARE source record; BEGIN
  FOR source IN SELECT * FROM account_change_sources LOOP
    IF to_regclass('public.'||source.source_table) IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=source.source_table AND column_name=source.owner_column) THEN
        RAISE EXCEPTION 'account signal owner definition missing';
      END IF;
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION capture_account_change(%L,%L,%L,%L)',
        'account_signal_'||source.domain,source.source_table,source.domain,source.owner_column,source.selected_columns,source.ignored_columns);
    END IF;
  END LOOP;
END $$;
