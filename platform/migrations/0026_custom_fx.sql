CREATE TABLE fx_provider_revisions (
 id uuid PRIMARY KEY, config jsonb NOT NULL,secret_cipher text,credential_instance uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER retain_fx_provider BEFORE UPDATE OR DELETE ON fx_provider_revisions FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();
ALTER TABLE fx_config ADD COLUMN provider_revision uuid REFERENCES fx_provider_revisions(id);
ALTER TABLE fx_refresh_tasks ADD COLUMN provider_revision uuid REFERENCES fx_provider_revisions(id);
ALTER TABLE fx_observations DROP CONSTRAINT fx_observations_provider_check;
ALTER TABLE fx_observations DROP CONSTRAINT fx_observations_source_uri_check;
ALTER TABLE fx_observations ALTER COLUMN observation_date DROP NOT NULL;
ALTER TABLE fx_observations ADD COLUMN provider_revision uuid REFERENCES fx_provider_revisions(id);
ALTER TABLE fx_observations ADD COLUMN source_precision text NOT NULL DEFAULT 'date' CHECK(source_precision IN ('unknown','date','instant'));
ALTER TABLE fx_observations ADD COLUMN source_instant timestamptz;
ALTER TABLE fx_values ADD COLUMN numerator numeric;
ALTER TABLE fx_values ADD COLUMN denominator numeric;
ALTER TABLE fx_values ADD CHECK((numerator IS NULL AND denominator IS NULL) OR (numerator>0 AND denominator>0 AND numerator=trunc(numerator) AND denominator=trunc(denominator)));
CREATE TABLE fx_schedule_firings (
 provider_revision uuid REFERENCES fx_provider_revisions(id),local_day date,slot text,request_id uuid UNIQUE NOT NULL REFERENCES fx_requests(request_id),PRIMARY KEY(provider_revision,local_day,slot)
);
ALTER TABLE fx_provider_revisions ADD CHECK(jsonb_typeof(config)='object');
ALTER TABLE fx_observations ADD CHECK(provider IN ('frankfurter-v1','custom'));
ALTER TABLE fx_observations ADD CHECK((provider='custom')=(provider_revision IS NOT NULL));
ALTER TABLE fx_observations ADD CHECK((source_precision='date')=(observation_date IS NOT NULL));
ALTER TABLE fx_observations ADD CHECK((source_precision='instant')=(source_instant IS NOT NULL));
ALTER TABLE fx_values ADD CHECK(numerator IS NULL OR (numerator<'Infinity'::numeric AND denominator<'Infinity'::numeric));
