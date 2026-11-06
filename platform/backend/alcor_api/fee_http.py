"""Exact legacy/canonical fee selection body bounds, without widening unrelated routes."""


def fee_body_budget(path):
    if path in {"/api/v1/account-assets/financing-policy","/api/v2/account-assets/financing-policy","/api/financing/policy/preview","/api/financing/policy/operations"}:return 8192
    if path in {
        "/api/fees/plans/preview",
        "/api/fees/plans/operations",
        "/api/v1/account-assets/trading/corrections/preview",
        "/api/v1/account-assets/trading/corrections",
        "/api/v2/account-assets/trading/corrections/preview",
        "/api/v2/account-assets/trading/corrections",
        "/api/trading/corrections/preview",
        "/api/trading/corrections/operations",
        "/api/fees/confirmations/native/preview",
        "/api/fees/confirmations/native/operations",
        "/api/fees/confirmations/preview",
        "/api/fees/confirmations/operations",
        "/api/fees/repairs/preview",
        "/api/fees/repairs/operations",
        "/api/v1/account-assets/fee-repairs/preview",
        "/api/v1/account-assets/fee-repairs/submissions",
        "/api/v2/account-assets/fee-repairs/preview",
        "/api/v2/account-assets/fee-repairs/submissions",
    }:
        return 131072
    if path in {"/api/v1/account-assets/trading/preview","/api/v1/account-assets/trading/submissions","/api/v2/account-assets/trading/preview","/api/v2/account-assets/trading/submissions"}:
        return 65536
    return 0
