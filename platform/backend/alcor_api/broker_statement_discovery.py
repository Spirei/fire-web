"""Actual statement capabilities, separate from the frozen legacy broker contract."""


def discovery(*, native=False):
    root = '/api/client/broker-statements' if native else '/api/account/broker-statements'
    return {
        'version': 1,
        'provider': 'ibkr-flex',
        'source_state_path': root + '/accounts/{account_id}/source',
        'source_configure_path': root + '/accounts/{account_id}/source',
        'source_disable_path': root + '/accounts/{account_id}/source',
        'source_disable_method': 'DELETE',
        'fetch_path': root + '/accounts/{account_id}/fetch',
        'source_operation_path': root + '/source-operations/{request_id}',
        'source_close_path': root + '/source-operations/{request_id}/close',
        'preview_path': root + '/preview',
        'preview_operation_path': root + '/operations/{request_id}',
        'preview_close_path': root + '/operations/{request_id}/close',
        'original_path': root + '/originals/{original_id}',
        'confirm_path': root + '/imports',
        'import_operation_path': root + '/imports/{request_id}',
        'import_close_path': root + '/imports/{request_id}/close',
        'read_scope': 'portfolio.read' if native else 'new-web-owner',
        'write_scope': 'portfolio.write' if native else 'new-web-owner',
        'explicit_source_installation_required': True,
        'source_readiness': 'query_source_state',
        'automatic_fetch': False,
        'automatic_retry': False,
        'confirmation_required': ['requestId', 'previewId', 'confirmExternalAccount', 'takeOverOfficial', 'acknowledgeUnassigned'],
        'confirmation_binding': 'current_instance_owner_session_role_grant_and_preview_revisions',
        'unknown_result': 'query_or_close_original_uuid',
        'manual_continuation': 'new_request_uuid_with_previous_pending_request_uuid',
        'cash_authority': 'reported_ending_cash_at_report_date',
        'withdrawal_capacity': False,
        'historical_trade_replay': False,
        'legacy_client_upgrade_required': True,
        'max_original_bytes': 8 * 1024 * 1024,
    }
