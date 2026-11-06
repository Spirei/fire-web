CREATE TABLE app_package_closed_operations (
 actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id)
);
CREATE TRIGGER immutable_app_package_closed_operation BEFORE UPDATE OR DELETE ON app_package_closed_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
