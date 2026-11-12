"""Versioned App discovery for reviewed, already mounted business protocols.

Protocol availability does not grant scopes or promise an observed quote/history.
"""


def discovery(version):
    base = f'/api/v{version}'
    return {
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
            'features': {
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
        'chart_series': {
            'version': 1, 'path': base + '/chart-series', 'markets': ['US', 'HK', 'CN'],
        },
    }
