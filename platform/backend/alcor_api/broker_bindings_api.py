"""Shared authenticated preview/receipt transport for scoped record ownership."""

from .broker_bindings import BrokerBindings
from .broker_metadata_api import mount_owned_metadata


def discovery(*, native=False):
    root = "/api/client/broker-bindings" if native else "/api/account/broker-bindings"
    return {
        "version": 1,
        "state_path": root,
        "preview_path": root + "/preview",
        "submit_path": root + "/operations",
        "operation_path": root + "/operations/{requestId}",
        "close_path": root + "/operations/{requestId}/close",
        "read_scope": "portfolio.read" if native else "new-web-owner",
        "write_scope": "portfolio.write" if native else "new-web-owner",
        "supported_operations": ["bind", "unbind"],
        "preview_required": True,
        "automatic_mutation_replay": False,
        "max_records": 2000,
        "candidate_limit": 200,
        "record_revisions_required": True,
        "explicit_account_kind_required": True,
        "history_reassignment": False,
        "cross_kind_assignment": False,
        "financial_transfer": False,
        "official_source_assignment": False,
        "coverage_scope": "platform_owned_verified_empty_records",
    }


def mount_broker_bindings(app, rate_limit):
    service = BrokerBindings(app.state.db)
    app.state.broker_bindings = service
    mount_owned_metadata(
        app, rate_limit, service, namespace="broker-bindings", capabilities=discovery, body_limit=524288
    )
