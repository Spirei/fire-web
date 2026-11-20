"""Versioned App discovery for reviewed, already mounted business protocols.

Protocol availability does not grant scopes or promise an observed quote/history.
"""


def discovery(version):
    base = f'/api/v{version}'
    assets = base + '/account-assets'
    trading = assets + '/trading'
    from .native_trade_sync import discovery as sync_discovery
    return {
        **({'native_trade_sync': sync_discovery()} if version == 2 else {}),
        'account_trading': {
            'version': 1, 'supported': True, 'snapshot_path': trading,
            'preview_path': trading + '/preview', 'submit_path': trading + '/submissions',
            'amend_path': trading + '/orders/{orderId}', 'amend_preview_path': trading + '/orders/{orderId}/preview',
            'observe_path': trading + '/orders/{orderId}/observations',
            'operation_path': assets + '/operations/{requestId}',
            'summary_path': assets + '/summary', 'positions_path': assets + '/positions', 'cash_path': assets + '/cash',
            'read_scope': 'orders.read', 'write_scope': 'orders.write', 'cancel_scope': 'orders.cancel',
            'cash_read_scope': 'cash.read', 'cash_write_scope': 'portfolio.write',
            'execution_model': 'internal_trade_ledger', 'external_broker_execution': False,
            'background_execution': False, 'automatic_mutation_replay': False,
            'request_id_field': 'requestId', 'snapshot_revision_field': 'snapshotRevision',
            'record_revision_field': 'recordRevision', 'order_revision_field': 'orderRevision',
            'idempotency': 'reject-duplicate-query-original',
            'partial_fills': False, 'margin': False, 'short_selling': False, 'derivatives': False,
            'stock_connect': 'record_only_actual_cny_net_settlement', 'fee_source': 'owner_recorded',
            'cash_basis': 'independent_recorded_currency_ledger',
            'portable_json_transfer': 'unsupported_for_api_trade_accounts_complete_database_backup_required',
            'buy_target': {
                'version': 1, 'supported': True, 'request_field': 'buyTarget',
                'confirmation_field': 'targetRevision', 'sides': ['buy'],
                'resolution': 'owned_manual_broker_canonical_security', 'creation': 'atomic_on_submission',
                'preview_creates_record': False,
            },
            'corrections': {
                'version': 1, 'preview_path': trading + '/corrections/preview', 'submit_path': trading + '/corrections',
                'actions': ['amend', 'merge', 'delete'], 'atomic': True, 'preserves_originals': True,
                'replays_following_orders': True, 'preview_revision_required': True, 'preview_max_age_seconds': 600,
            },
        },
        'broker_accounts': {
            'version': 1, 'presets_path': base + '/broker-accounts/presets',
            'accounts_path': base + '/broker-accounts', 'account_path': base + '/broker-accounts/{accountId}',
            'icon_path': base + '/broker-accounts/{accountId}/icon',
            'operation_path': base + '/broker-accounts/operations/{requestId}',
            'read_scope': 'portfolio.read', 'write_scope': 'portfolio.write',
            'request_id_field': 'requestId', 'revision_field': 'revision', 'automatic_mutation_replay': False,
            'icon_upload': {'content_types': ['image/png', 'image/jpeg', 'image/webp'],
                            'max_bytes': 2097152, 'max_dimension': 4096, 'max_pixels': 16777216},
            'record_binding': 'owner_record_group_exact_account_name', 'delete_referenced_account': 'reject',
            'record_binding_id_field': 'brokerAccountId',
            'binding_path': base + '/broker-accounts/{accountId}/bindings',
            'unbinding_path': base + '/broker-accounts/{accountId}/unbindings',
        },
        'account_assets': {
            'version': 1, 'snapshot_path': base + '/account-assets',
            'instrument_path': base + '/account-assets/instruments/{recordId}',
            'operation_path': base + '/account-assets/operations/{requestId}',
            'read_scope': 'portfolio.read', 'write_scope': 'portfolio.write',
            'snapshot_revision_field': 'snapshotRevision', 'record_collection_revision_field': 'collectionRevision',
            'request_id_field': 'requestId', 'idempotency': 'reject-duplicate-query-original',
            'automatic_mutation_replay': False,
            'orders_version': 1, 'orders_path': base + '/account-assets/orders',
            'cancel_orders_path': base + '/account-assets/orders/cancellations',
            'order_revision_field': 'revision', 'cancel_scope': 'orders.cancel',
            'order_filters': ['all', 'pending', 'filled', 'cancelled', 'rejected', 'expired'],
            'features': {
                'all_orders': True, 'batch_cancel_pending': True,
                'cash_by_currency': True, 'cash_price_independent': True,
                'cash_valuation': 'recorded_cash_ledger_price_independent', 'cash_by_market': False,
                'today_orders': False, 'order_reads_settle': False,
                'instrument_declarations': ['cash_equity', 'etf', 'unknown'],
                'derivatives': False, 'underlying_merge': False, 'listing_status': 'owner_declared',
                'average_open_cost': 'reconciled_zero_opening_cycle_only', 'diluted_cost': 'stored_position_cost',
                'account_day_pnl': False, 'position_day_pnl': False, 'extended_hours': 'observed_quote_only',
                'regular_hours_price_selection': True, 'smart_market_sort': False,
                'legacy_record_valuation': 'stored_unit_price_times_quantity',
            },
        },
        'records_contract': {
            'version': 1, 'supported': True,
            'records_path': base + '/records', 'record_path': base + '/records/{id}',
            'operation_path': base + '/records/operations/{requestId}',
            'search_path': base + '/search',
            'read_scope': 'portfolio.read', 'write_scope': 'portfolio.write',
            'request_id_field': 'requestId', 'revision_field': 'revision',
            'collection_revision_field': 'collectionRevision',
            'idempotency': 'reject-duplicate-query-original', 'automatic_mutation_replay': False,
        },
        'market_amount_ranking': {
            'version': 1, 'path': base + '/market-ranking', 'markets': ['US', 'HK', 'CN'], 'metric': 'amount',
        },
        'stock_history': {
            'version': 1, 'path': base + '/stock-detail', 'view': 'history',
            'adjustments': ['qfq', 'none'], 'default_adjust': 'qfq',
            'verified_adjust_field': 'adjust', 'read_scope': 'portfolio.read',
        },
        'chart_series': {
            'version': 1, 'path': base + '/chart-series', 'markets': ['US', 'HK', 'CN'],
        },
    }
