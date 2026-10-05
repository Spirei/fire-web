export function assetsDiscovery(version: 1 | 2) {
  const base = `/api/v${version}/account-assets`;
  return {
    version: 1, snapshot_path: base, instrument_path: `${base}/instruments/{recordId}`,
    operation_path: `${base}/operations/{requestId}`, read_scope: "portfolio.read", write_scope: "portfolio.write",
    snapshot_revision_field: "snapshotRevision", record_collection_revision_field: "collectionRevision",
    request_id_field: "requestId", idempotency: "reject-duplicate-query-original", automatic_mutation_replay: false,
    features: { cash_by_currency: true, cash_by_market: false, today_orders: true, order_reads_settle: false,
      instrument_declarations: ["cash_equity", "etf", "unknown"], derivatives: false, underlying_merge: false,
      listing_status: "owner_declared", average_open_cost: "reconciled_zero_opening_cycle_only",
      diluted_cost: "stored_position_cost", account_day_pnl: false, position_day_pnl: false,
      extended_hours: "observed_quote_only", regular_hours_price_selection: false, smart_market_sort: false },
    defaults: { currency: "USD", cost_method: "diluted", us_price: "observed" },
    unavailable_values: "null", legacy_fallback: ["records", "overview"],
    order_writes: "existing_cash_equity_contract_only_no_new_write_capability"
  };
}
