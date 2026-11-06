"""Scoped canonical paired-position-transfer transport."""
from .broker_metadata_api import mount_owned_metadata
from .broker_position_transfers import BrokerPositionTransfers


def discovery(*, native=False):
    root = '/api/client/broker-position-transfers' if native else '/api/account/broker-position-transfers'
    return {'version': 1, 'state_path': root, 'preview_path': root + '/preview', 'submit_path': root + '/operations',
            'operation_path': root + '/operations/{requestId}', 'close_path': root + '/operations/{requestId}/close',
            'same_owner_required': True, 'same_account_kind_required': True, 'full_position_only': True,
            'new_target_record_required': True, 'cash_effect': 'none', 'original_trade_history_moved': False,
            'source_authority': 'owner_recorded_transfer', 'automatic_mutation_replay': False}


def mount_broker_position_transfers(app, rate_limit):
    service = BrokerPositionTransfers(app.state.db)
    app.state.broker_position_transfers = service
    mount_owned_metadata(app, rate_limit, service, namespace='broker-position-transfers', capabilities=discovery)
