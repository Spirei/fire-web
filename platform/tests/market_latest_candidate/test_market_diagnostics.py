"""Controlled SDK contract checks; no installed SDK, network or real account."""
import pytest

from alcor_api.legacy_futu_diagnostics import quota_projection
from alcor_api.market_futu_sdk import diagnostic_collect


class DiagnosticContext:
    def __init__(self, *, failed=False):
        self.calls = []
        self.failed = failed

    def get_global_state(self):
        self.calls.append('state')
        return 0, {'qot_logined': True, 'credential': 'must-not-leave-child'}

    def query_subscription(self, *, is_all_conn):
        assert is_all_conn is False
        self.calls.append('current-subscription')
        if self.failed:
            raise RuntimeError('private SDK error')
        return 0, {'total_used': 4, 'remain': 0, 'own_used': 1,
                   'sub_list': ['another-private-symbol'], 'secret': 'private'}

    def get_history_kl_quota(self, *, get_detail):
        assert get_detail is False
        self.calls.append('history-counters')
        return 0, (3, 7, ['private-security-list'])

    def close(self):
        self.calls.append('close')


def execute(context, action):
    return diagnostic_collect(lambda **_: context, 0,
                              {'action': action, 'host': 'controlled', 'port': 1234})


def test_connection_check_does_not_fetch_quotes_or_claim_quote_permission():
    context = DiagnosticContext()
    result = execute(context, 'futu.test')
    assert context.calls == ['state', 'close']
    assert result == {'qotLogined': True, 'responded': True, 'quotePermissionVerified': False}


def test_quota_keeps_actual_zero_and_discards_security_lists_and_credentials():
    context = DiagnosticContext()
    result = execute(context, 'futu.quota')
    assert context.calls == ['current-subscription', 'history-counters', 'close']
    projected = quota_projection(result)
    assert projected['subscription'] == {'totalUsed': 4, 'remain': 0, 'ownUsed': 1,
                                          'totalQuota': None, 'ownTotalQuota': None}
    assert projected['historyKl'] == {'used': 3, 'remain': 7, 'totalQuota': None}
    assert 'private' not in repr(result) and 'private' not in repr(projected)


def test_partial_failure_does_not_convert_unknown_subscription_into_zero():
    context = DiagnosticContext(failed=True)
    result = quota_projection(execute(context, 'futu.quota'))
    assert result['subscription'] is None and result['historyKl']['used'] == 3
    assert context.calls[-1] == 'close'


@pytest.mark.parametrize('value', [{}, {'subscription': {'total_used': True, 'remain': -1}},
                                  {'historyKl': {'used_quota': 1.5}}])
def test_no_valid_observation_stays_unknown(value):
    assert quota_projection(value) is None
