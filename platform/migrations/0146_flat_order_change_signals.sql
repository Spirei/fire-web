-- Display-only append receipts are a real owner portfolio change, not request telemetry.
INSERT INTO account_change_sources(domain,source_table,owner_column,selected_columns,ignored_columns)
VALUES('portfolio','legacy_flat_order_operations','owner_id','','')
ON CONFLICT(domain,source_table) DO NOTHING;
CREATE TRIGGER account_signal_portfolio AFTER INSERT OR UPDATE OR DELETE ON legacy_flat_order_operations
FOR EACH ROW EXECUTE FUNCTION capture_account_change('portfolio','owner_id','','');
-- A newly covered source invalidates old cursors without inventing historical commits.
UPDATE account_change_metadata SET epoch=gen_random_uuid();
