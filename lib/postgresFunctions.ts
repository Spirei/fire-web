import { identifier } from "./postgresSql";
/** Functions used by the existing financial guards, executed by PostgreSQL in the same transaction. */
export function postgresFunctions(schema: string) {
  const s = identifier(schema);
  return `
CREATE OR REPLACE FUNCTION ${s}.alcor_nocase(value TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT translate(value,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') $$;
CREATE OR REPLACE FUNCTION ${s}.julianday(value TEXT) RETURNS NUMERIC LANGUAGE plpgsql STABLE STRICT AS $$
BEGIN RETURN extract(epoch FROM value::timestamptz)/86400+2440587.5; EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION ${s}.json_extract(value TEXT,path TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN IF path !~ '^\\$\\.[A-Za-z_][A-Za-z0-9_.]*$' THEN RAISE EXCEPTION 'Unsupported JSON path'; END IF; RETURN value::jsonb #>> string_to_array(substr(path,3),'.'); END $$;
CREATE OR REPLACE FUNCTION ${s}.json_valid(value TEXT) RETURNS BIGINT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN IF value IS NULL THEN RETURN 0; END IF; PERFORM value::jsonb; RETURN 1; EXCEPTION WHEN invalid_text_representation THEN RETURN 0; END $$;
CREATE OR REPLACE FUNCTION ${s}.alcor_json_object(key TEXT,value TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT json_build_object(key,value)::text $$;
CREATE OR REPLACE FUNCTION ${s}.trade_correction_allowed(id TEXT) RETURNS BIGINT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN coalesce(nullif(current_setting('alcor.trade_correction_ids',true),''),'[]')::jsonb ? id THEN 1 ELSE 0 END::bigint $$;
CREATE OR REPLACE FUNCTION ${s}.broker_cash_fee_correction(id TEXT) RETURNS BIGINT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN coalesce(nullif(current_setting('alcor.fee_correction_ids',true),''),'[]')::jsonb ? id THEN 1 ELSE 0 END::bigint $$;
${["broker_cash_conflict", "broker_source_conflict", "trade_correction_conflict"].map(name => `CREATE OR REPLACE FUNCTION ${s}.${name}() RETURNS BIGINT LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'alcor:${name}'; END $$;`).join("\n")}
`;
}
