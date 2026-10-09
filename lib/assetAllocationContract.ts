export const ALLOCATION_READ_TIMEOUT_MS = 8_000;
export const ALLOCATION_WRITE_TIMEOUT_MS = 12_000;
export const ALLOCATION_REFRESH_MS = 30_000;

export function allocationDiscovery(version: 1 | 2) {
  const base = `/api/v${version}/asset-allocation`;
  return { version: 1, snapshot_path: base, accounts_path: base, assign_path: `${base}/assign`,
    read_scope: "portfolio.read", write_scope: "portfolio.write", linked_sources: ["records", "funds", "cards", "simple-ledger"],
    source_connection: "local-ledgers", external_institution_connections: false,
    revision_field: "revision", snapshot_revision_field: "snapshotRevision", create_request_id_field: "requestId",
    owner_header: "X-Allocation-User", conditional_read: "weak-etag", checked_at_header: "X-Allocation-Observed-At",
    recommended_read_timeout_ms: ALLOCATION_READ_TIMEOUT_MS, recommended_write_timeout_ms: ALLOCATION_WRITE_TIMEOUT_MS,
    refresh_after_ms: ALLOCATION_REFRESH_MS, unavailable_values: "null", automatic_mutation_replay: false,
    linked_amount_mode_field: "amountMode", linked_amount_modes: ["automatic", "statement"], default_amount_mode: "statement", restore_preserves_name: true };
}
