-- Public branding and registration policy only. Provider credentials stay in
-- their dedicated authorities; changing domain never changes runtime Origin.
CREATE TABLE site_settings (
 singleton boolean PRIMARY KEY CHECK(singleton=true),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
 allow_register boolean NOT NULL DEFAULT true,
 settings jsonb NOT NULL DEFAULT '{}'::jsonb,
 CHECK(jsonb_typeof(settings)='object' AND settings-ARRAY['title','ico','homepageBg','loginSideImage','domain','siteLogo','logoText','logoFont','footerDesc','homeNav','marketBadges','marketBadgesVisible']='{}'::jsonb)
);
INSERT INTO site_settings(singleton) VALUES(true);
CREATE TABLE site_settings_operations (
 owner_id text NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 closed boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),
 CHECK(NOT closed OR result->>'state'='closed')
);
CREATE TRIGGER site_settings_operation_immutable BEFORE UPDATE OR DELETE ON site_settings_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
