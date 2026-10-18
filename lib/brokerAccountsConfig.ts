import { FUND_CURRENCIES } from "./fundCurrencies";
import { BROKER_STATEMENT_CONNECTORS } from "./brokerConnectors";
export function brokerAccountsDiscovery(version: 1 | 2) {
  const base = `/api/v${version}/broker-accounts`;
  return {cash_ledger:{version:1,supported:true,read_models:{version:1,entry_balance_after:true,activity_summary:true,withdrawal_capacity:true,statement_snapshot_scope:"broker_currency"},summary_path:`${base}/cash`,account_path:`${base}/{accountId}/cash`,entries_path:`${base}/{accountId}/cash/entries`,preview_path:`${base}/cash/preview`,submit_path:`${base}/cash/submissions`,operation_path:`${base}/operations/{requestId}`,read_scope:"portfolio.read",write_scope:"portfolio.write",actions:["opening","external_deposit","external_withdrawal"],transfer_counterparties:[],opening_bases:["allocate_verified_unallocated_checkpoint","new_external_opening"],cash_basis:"single_global_ledger_attribution",currency_policy:"explicit_supported_currency",supported_currencies:FUND_CURRENCIES,trading_cash_basis:"owner_currency_ledger",trading_enforced:false,preview_required:true,automatic_mutation_replay:false,cross_currency_transfer:false,official_cash_auto_post:false},version:1,presets_path:`${base}/presets`,accounts_path:base,account_path:`${base}/{accountId}`,
    icon_path:`${base}/{accountId}/icon`,operation_path:`${base}/operations/{requestId}`,
    read_scope:"portfolio.read",write_scope:"portfolio.write",request_id_field:"requestId",revision_field:"revision",
    automatic_mutation_replay:false,
    icon_upload:{content_types:["image/png","image/jpeg","image/webp"],max_bytes:2097152,max_dimension:4096,max_pixels:16777216},
    currency_selection:{version:1,field:"currencies",default_field:"currency",supported:FUND_CURRENCIES,usage_field:"currencyUsage",removal_requires_complete:true},
    holding_source:{version:1,field:"holdingSource",manual_path:`${base}/{accountId}/holding-source`,takeover_field:"takeOverOfficial",default_source:"manual",offline_fallback:false},
    record_binding_id_field:"brokerAccountId",binding_path:`${base}/{accountId}/bindings`,unbinding_path:`${base}/{accountId}/unbindings`,
    statements:{connectors:BROKER_STATEMENT_CONNECTORS,connection_path:`${base}/{accountId}/connection`,preview_path:`${base}/{accountId}/statements/preview`,fetch_path:`${base}/{accountId}/statements/fetch`,apply_path:`${base}/{accountId}/statements/apply`,max_bytes:8388608,preview_required:true,automatic_apply:false},
    record_binding:"owner_record_group_exact_account_name",delete_referenced_account:"reject"};
}
