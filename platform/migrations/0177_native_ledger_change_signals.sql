-- One committed App transaction advances the owner's portfolio watermark.
INSERT INTO account_change_sources(domain,source_table,owner_column,selected_columns,ignored_columns)
VALUES('portfolio','native_ledger_transactions','owner_id','','');
CREATE TRIGGER account_signal_portfolio AFTER INSERT OR UPDATE OR DELETE ON native_ledger_transactions
FOR EACH ROW EXECUTE FUNCTION capture_account_change('portfolio','owner_id','','');
UPDATE account_change_metadata SET epoch=gen_random_uuid();
