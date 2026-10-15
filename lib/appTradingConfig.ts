export function tradingDiscovery(version: 1 | 2) {
  const base = `/api/v${version}/account-assets`;
  return { version: 1, supported: true, instrument_declaration_required: false, snapshot_path: `${base}/trading`, preview_path: `${base}/trading/preview`,
    submit_path: `${base}/trading/submissions`, amend_path: `${base}/trading/orders/{orderId}`, amend_preview_path: `${base}/trading/orders/{orderId}/preview`,
    observe_path: `${base}/trading/orders/{orderId}/observations`, operation_path: `${base}/operations/{requestId}`,
    summary_path: `${base}/summary`, positions_path: `${base}/positions`, cash_path: `${base}/cash`,
    read_scope: "orders.read", write_scope: "orders.write", cancel_scope: "orders.cancel", cash_read_scope: "cash.read", cash_write_scope: "portfolio.write",
    execution_model: "internal_trade_ledger", external_broker_execution: false, background_execution: false,
    modes: ["record", "order"], sides: ["buy", "sell", "dividend"], order_types: ["limit", "market"],
    sessions: ["REGULAR", "EXTENDED"], extended_hours_markets: ["US"], time_in_force: ["day", "gtc"],
    partial_fills: false, margin: false, short_selling: false, derivatives: false, attachments: "atomic_oco_after_full_fill",
    stock_connect: "record_only_actual_cny_net_settlement", quantity_decimals: 8, quantity_unit: "recorded_units", exchange_lot_size: null,
    fee_source: "owner_recorded", fee_breakdown: null, cash_basis: "independent_recorded_currency_ledger", reservations: "pending_order_preview_checked_at_execution",
    request_id_field: "requestId", snapshot_revision_field: "snapshotRevision", record_revision_field: "recordRevision", order_revision_field: "orderRevision",
    idempotency: "reject-duplicate-query-original", automatic_mutation_replay: false, quote_max_age_seconds: 30,
    portable_json_transfer: "unsupported_for_api_trade_accounts_complete_database_backup_required" };
}
