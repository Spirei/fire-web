export function brokerAccountsDiscovery(version: 1 | 2) {
  const base = `/api/v${version}/broker-accounts`;
  return {version:1,presets_path:`${base}/presets`,accounts_path:base,account_path:`${base}/{accountId}`,
    icon_path:`${base}/{accountId}/icon`,operation_path:`${base}/operations/{requestId}`,
    read_scope:"portfolio.read",write_scope:"portfolio.write",request_id_field:"requestId",revision_field:"revision",
    automatic_mutation_replay:false,
    icon_upload:{content_types:["image/png","image/jpeg","image/webp"],max_bytes:2097152,max_dimension:4096,max_pixels:16777216},
    record_binding:"owner_record_group_exact_account_name",delete_referenced_account:"reject"};
}
