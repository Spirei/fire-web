-- New signal source topology is a new comparison generation, not imported history.
ALTER TABLE account_change_sources ADD COLUMN covered_since timestamptz NOT NULL DEFAULT clock_timestamp();
INSERT INTO account_change_sources(domain,source_table,owner_column,selected_columns,ignored_columns) VALUES
('authorization','legacy_source_grants','owner_id','',''),
('authorization','market_source_configs','owner_id','',''),
('authorization','market_source_revocations','owner_id','',''),
('portfolio','trade_amendments','owner_id','',''),
('portfolio','trade_fee_projections','owner_id','',''),
('portfolio','trade_fee_corrections','owner_id','',''),
('portfolio','actual_fee_confirmations','owner_id','',''),
('portfolio','native_actual_fee_confirmations','owner_id','',''),
('portfolio','broker_statement_imports','owner_id','',''),
('portfolio','broker_statement_positions','owner_id','',''),
('portfolio','broker_position_transfers','owner_id','',''),
('portfolio','broker_position_transfer_events','owner_id','',''),
('portfolio','fund_sources','owner_id','',''),
('portfolio','fund_source_retirements','owner_id','',''),
('portfolio','asset_instrument_heads','owner_id','',''),
('portfolio','internal_order_contexts','owner_id','',''),
('portfolio','internal_order_family_legs','owner_id','',''),
('portfolio','card_wallet_collections','owner_id','',''),
('watch','portfolio_record_orderings','owner_id','',''),
('watch','watch_group_icon_versions','owner_id','',''),
('watch','watch_group_source_bindings','owner_id','',''),
('brokers','broker_statement_sources','owner_id','',''),
('brokers','broker_icon_versions','owner_id','',''),
('alerts','business_notification_bindings','owner_id','',''),
('alerts','business_notification_provider_revisions','owner_id','',''),
('alerts','business_notification_provider_revocations','owner_id','',''),
('alerts','business_notification_provider_checks','owner_id','',''),
('alerts','business_notification_challenges','owner_id','',''),
('alerts','business_notification_deliveries','owner_id','',''),
('settings','card_preference_collections','owner_id','',''),
('settings','card_custom_records','owner_id','',''),
('settings','card_wallet_details','owner_id','',''),
('settings','registered_fee_baseline_heads','owner_id','',''),
('settings','legacy_fee_estimation_heads','owner_id','',''),
('settings','fee_legacy_inventory_heads','owner_id','',''),
('settings','fee_legacy_attributions','owner_id','','')
ON CONFLICT(domain,source_table) DO NOTHING;
DO $$ DECLARE source record; BEGIN
 FOR source IN SELECT * FROM account_change_sources LOOP
  IF to_regclass('public.'||source.source_table) IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||source.source_table)
      AND tgname='account_signal_'||source.domain AND NOT tgisinternal) THEN
   IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name=source.source_table AND column_name=source.owner_column) THEN
    RAISE EXCEPTION 'account signal owner definition missing'; END IF;
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION capture_account_change(%L,%L,%L,%L)',
     'account_signal_'||source.domain,source.source_table,source.domain,source.owner_column,source.selected_columns,source.ignored_columns);
  END IF;
 END LOOP;
END $$;
UPDATE account_change_metadata SET epoch=gen_random_uuid(),installed_at=clock_timestamp() WHERE singleton;
