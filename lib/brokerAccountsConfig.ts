import { BROKER_STATEMENT_CONNECTORS } from "./brokerConnectors";
export function brokerAccountsDiscovery(version: 1 | 2) {
  const base = `/api/v${version}/broker-accounts`;
  return {version:1,presets_path:`${base}/presets`,accounts_path:base,account_path:`${base}/{accountId}`,
    icon_path:`${base}/{accountId}/icon`,operation_path:`${base}/operations/{requestId}`,
    read_scope:"portfolio.read",write_scope:"portfolio.write",request_id_field:"requestId",revision_field:"revision",
    automatic_mutation_replay:false,
    icon_upload:{content_types:["image/png","image/jpeg","image/webp"],max_bytes:2097152,max_dimension:4096,max_pixels:16777216},
    holding_source:{version:1,field:"holdingSource",manual_path:`${base}/{accountId}/holding-source`,takeover_field:"takeOverOfficial",default_source:"manual",offline_fallback:false},
    record_binding_id_field:"brokerAccountId",binding_path:`${base}/{accountId}/bindings`,
    statements:{connectors:BROKER_STATEMENT_CONNECTORS,connection_path:`${base}/{accountId}/connection`,preview_path:`${base}/{accountId}/statements/preview`,fetch_path:`${base}/{accountId}/statements/fetch`,apply_path:`${base}/{accountId}/statements/apply`,max_bytes:8388608,preview_required:true,automatic_apply:false},
    record_binding:"owner_record_group_exact_account_name",delete_referenced_account:"reject"};
}
