"""Canonical owner-scoped source projection preview and confirmation."""
from .broker_holding_source import BrokerHoldingSource
from .broker_metadata_api import mount_owned_metadata


def discovery(*, native=False):
    root = '/api/client/broker-holding-source' if native else '/api/account/broker-holding-source'
    return {'version': 1, 'supported': True, 'state_path': root, 'preview_path': root + '/preview',
            'submit_path': root + '/operations', 'operation_path': root + '/operations/{requestId}',
            'close_path': root + '/operations/{requestId}/close', 'preview_required': True,
            'supported_operations': ['holding-source'], 'allowed_source': 'manual',
            'financial_history_changed': False, 'snapshot_to_ledger_copy': False,
            'projection_change_acknowledgement_required': True, 'automatic_mutation_replay': False}


def mount_broker_holding_source(app, rate_limit):
    service = BrokerHoldingSource(app.state.db)
    app.state.broker_holding_source = service
    mount_owned_metadata(app, rate_limit, service, namespace='broker-holding-source', capabilities=discovery)
