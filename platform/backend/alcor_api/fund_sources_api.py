"""Canonical funding-source and inverse-posting receipt transport."""
from fastapi import HTTPException

from .broker_accounts import CURRENCIES
from .broker_metadata_api import mount_owned_metadata
from .fund_sources import FundSources


def discovery(*, native=False):
    root = '/api/client/fund-sources' if native else '/api/account/fund-sources'
    return {'version': 1, 'state_path': root, 'preview_path': root + '/preview', 'submit_path': root + '/operations',
            'operation_path': root + '/operations/{requestId}', 'close_path': root + '/operations/{requestId}/close',
            'preview_required': True, 'explicit_account_kind_required': True, 'amount_representation': 'exact_decimal_text',
            'deletion_effect': 'inverse_posting_with_retained_original', 'order_or_card_linked_delete': False,
            'automatic_mutation_replay': False}


def state_query(query):
    if any(k not in ('limit', 'offset', 'revision', 'currency', 'q') or len(query.getlist(k)) != 1 for k in query):
        raise HTTPException(400, '资金来源查询参数无效')
    result = {}
    for key in ('limit', 'offset', 'revision'):
        if key in query:
            value = query[key]
            if not value.isascii() or not value.isdecimal() or len(value) > 10:
                raise HTTPException(422, '资金来源分页无效')
            result[key] = int(value)
    if 'currency' in query:
        if query['currency'] not in CURRENCIES:
            raise HTTPException(422, '币种无效')
        result['currency'] = query['currency']
    if 'q' in query:
        result['query'] = query['q']
    return result


def mount_fund_sources(app, rate_limit):
    service = FundSources(app.state.db)
    app.state.fund_sources = service
    mount_owned_metadata(app, rate_limit, service, namespace='fund-sources', capabilities=discovery, state_query=state_query)
