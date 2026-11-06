-- Immutable market-reference sources, annual plans and bounded FX refresh work.
CREATE FUNCTION retain_reference_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'reference observations are immutable'; END $$;
CREATE TABLE market_calendar_releases (
 revision text PRIMARY KEY, schema_version int NOT NULL CHECK(schema_version=1),
 original_bytes bytea NOT NULL, original_sha256 text NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE market_calendar_markets (
 revision text REFERENCES market_calendar_releases(revision), market text CHECK(market IN ('CN','HK','US')),
 name text NOT NULL, timezone text NOT NULL, exchanges text[] NOT NULL, verified_years int[] NOT NULL,
 PRIMARY KEY(revision,market)
);
CREATE TABLE market_calendar_years (
 revision text, market text,year int CHECK(year BETWEEN 2000 AND 2100),verified_at date NOT NULL,
 PRIMARY KEY(revision,market,year),FOREIGN KEY(revision,market) REFERENCES market_calendar_markets(revision,market)
);
CREATE TABLE market_calendar_sources (
 revision text,market text,year int,source_id text,title text NOT NULL,url text NOT NULL,
 published_at date,verified_at date NOT NULL,
 PRIMARY KEY(revision,market,year,source_id),FOREIGN KEY(revision,market,year) REFERENCES market_calendar_years(revision,market,year)
);
CREATE TABLE market_calendar_days (
 revision text,market text,day date,status text CHECK(status IN ('trading','weekend','holiday','half_day','unknown')),
 name text,reason text CHECK(reason IN ('official_schedule','temporary_uncertainty')),
 continuous_close text,auction_earliest text,auction_latest text,source_ids text[] NOT NULL,
 PRIMARY KEY(revision,market,day),FOREIGN KEY(revision,market) REFERENCES market_calendar_markets(revision,market),
 CHECK((status='half_day')=(continuous_close IS NOT NULL)),CHECK((auction_earliest IS NULL)=(auction_latest IS NULL))
);
CREATE TRIGGER retain_calendar_release BEFORE UPDATE OR DELETE ON market_calendar_releases FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();
CREATE TRIGGER retain_calendar_day BEFORE UPDATE OR DELETE ON market_calendar_days FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();
CREATE TABLE fx_observations (
 id uuid PRIMARY KEY,provider text NOT NULL,source_uri text NOT NULL,base_currency text NOT NULL,
 observation_date date NOT NULL,received_at timestamptz NOT NULL,original_bytes bytea NOT NULL,
 raw_sha256 text NOT NULL,normalized_sha256 text NOT NULL
);
CREATE TABLE fx_values (
 observation_id uuid REFERENCES fx_observations(id),currency text CHECK(currency ~ '^[A-Z]{3}$'),
 rate numeric NOT NULL CHECK(rate>0 AND rate<'Infinity'::numeric),PRIMARY KEY(observation_id,currency)
);
CREATE TABLE fx_refresh_tasks (
 id uuid PRIMARY KEY,owner_id text REFERENCES users(id),provider text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','completed','failed','interrupted')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),started_at timestamptz,completed_at timestamptz,
 observation_id uuid REFERENCES fx_observations(id),error_code text
);
CREATE TRIGGER retain_fx_observation BEFORE UPDATE OR DELETE ON fx_observations FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();
CREATE TRIGGER retain_fx_values BEFORE UPDATE OR DELETE ON fx_values FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();
CREATE TABLE market_calendar_active (singleton boolean PRIMARY KEY CHECK(singleton),revision text NOT NULL REFERENCES market_calendar_releases(revision));
CREATE TRIGGER retain_calendar_market BEFORE UPDATE OR DELETE ON market_calendar_markets FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();
CREATE TRIGGER retain_calendar_year BEFORE UPDATE OR DELETE ON market_calendar_years FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();
CREATE TRIGGER retain_calendar_source BEFORE UPDATE OR DELETE ON market_calendar_sources FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();
CREATE TABLE fx_config (singleton boolean PRIMARY KEY CHECK(singleton),enabled boolean NOT NULL DEFAULT false,daily_budget int NOT NULL CHECK(daily_budget BETWEEN 1 AND 1000),revision bigint NOT NULL DEFAULT 1);
INSERT INTO fx_config(singleton,daily_budget) VALUES(true,12);
CREATE TABLE fx_daily_usage(day date PRIMARY KEY,calls int NOT NULL CHECK(calls>=0));
CREATE TABLE fx_rate_windows(key_hash text NOT NULL,minute timestamptz NOT NULL,count int NOT NULL,PRIMARY KEY(key_hash,minute));
CREATE TABLE fx_requests(request_id uuid PRIMARY KEY,principal text NOT NULL,task_id uuid NOT NULL REFERENCES fx_refresh_tasks(id));

ALTER TABLE market_calendar_releases ADD CHECK(length(revision) BETWEEN 1 AND 80), ADD CHECK(original_sha256 ~ '^[a-f0-9]{64}$'), ADD CHECK(octet_length(original_bytes) BETWEEN 1 AND 2000000);
ALTER TABLE fx_observations ADD CHECK(provider='frankfurter-v1'), ADD CHECK(source_uri='https://api.frankfurter.dev/v1/latest?base=USD'), ADD CHECK(base_currency='USD'), ADD CHECK(raw_sha256 ~ '^[a-f0-9]{64}$'), ADD CHECK(normalized_sha256 ~ '^[a-f0-9]{64}$'), ADD CHECK(octet_length(original_bytes) BETWEEN 1 AND 131072);
ALTER TABLE fx_config ADD CHECK(revision>=1);
ALTER TABLE fx_requests ADD CHECK(principal ~ '^[a-f0-9]{64}$');
ALTER TABLE fx_rate_windows ADD CHECK(key_hash ~ '^[a-f0-9]{64}$'), ADD CHECK(count>0);
CREATE INDEX fx_tasks_pending ON fx_refresh_tasks(created_at,id) WHERE state IN ('queued','running');
CREATE INDEX fx_observations_latest ON fx_observations(provider,observation_date DESC,received_at DESC,id DESC);
CREATE TRIGGER retain_fx_request BEFORE UPDATE OR DELETE ON fx_requests FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();
