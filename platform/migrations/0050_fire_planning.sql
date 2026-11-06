CREATE TABLE fire_planning_settings (
    owner_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    value jsonb NOT NULL CHECK (jsonb_typeof(value)='object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO account_change_sources(domain,source_table,owner_column,selected_columns,ignored_columns)
VALUES('settings','fire_planning_settings','owner_id','value','');
CREATE TRIGGER account_signal_settings
AFTER INSERT OR UPDATE OR DELETE ON fire_planning_settings
FOR EACH ROW EXECUTE FUNCTION capture_account_change('settings','owner_id','value','');
