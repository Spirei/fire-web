from decimal import Decimal as D
from decimal import localcontext

import pytest
from alcor_api.trade_accounting import (
    AccountingError,
    EconomicPosition,
    FilledTrade,
    Position,
    apply_filled_trade,
    cash_delta,
    number,
    replay_economic_trades,
    rounded,
)


def trade(side, qty, price, fees="0", *, amount=None, currency="USD", settlement=None, net=None):
    q, p = D(qty), D(price)
    return FilledTrade(
        side,
        q,
        p,
        None if fees is None else D(fees),
        D(amount) if amount is not None else q * p,
        currency,
        settlement or currency,
        None if net is None else D(net),
    )


def test_broker_dilution_is_not_economic_realized_profit():
    events = [trade("buy", "100", "10", "2"), trade("sell", "40", "12", "1"), trade("sell", "30", "13", "1")]
    position = Position(D(0), D(0))
    displayed_realized = D(0)
    for event in events:
        result = apply_filled_trade(position, event)
        position = result.position
        displayed_realized += result.realized_pnl or D(0)
    economic = replay_economic_trades(Position(D(0), D(0)), events)
    assert position == Position(D(30), D("4.400"))
    assert economic.position == EconomicPosition(D(30), D("10.02"))
    assert economic.realized_pnl == D("166.60")
    assert displayed_realized != economic.realized_pnl
    # Closing wealth plus cash flows equals realized + remaining economic P&L.
    cash = sum(cash_delta(event) for event in events)
    assert (
        D(14) * position.quantity + cash
        == economic.realized_pnl + (D(14) - economic.position.cost) * position.quantity
    )


def test_recorded_dividend_zero_and_non_product_amount_preserved():
    position = Position(D(60), D("9.02"))
    dividend = trade("dividend", "60", "1", "2", amount="47.83")
    result = apply_filled_trade(position, dividend)
    assert result.position == position
    assert result.realized_pnl == result.cash == D("45.83")
    assert apply_filled_trade(position, trade("dividend", "60", "1", amount="0")).cash == 0


def test_hong_kong_connect_uses_verified_cny_net_once():
    event = trade("buy", "100", "10", "8", currency="HKD", settlement="CNY", net="925.77")
    result = apply_filled_trade(Position(D(0), D(0)), event)
    assert result.position.cost == D("10.080")
    assert result.cash == D("-925.77") and result.cash_currency == "CNY"
    assert cash_delta(trade("buy", "100", "10", "8", currency="HKD", settlement="CNY")) is None


def test_unknown_fees_and_opening_never_turn_into_zero_pnl():
    unknown = trade("buy", "5", "4", None)
    assert cash_delta(unknown) is None
    assert apply_filled_trade(Position(D(0), D(0)), unknown).position.cost is None
    events = [trade("sell", "5", "20"), trade("buy", "3", "4")]
    result = replay_economic_trades(Position(D(5), None), events)
    assert result.position == EconomicPosition(D(3), D(4))
    assert result.realized_pnl is None and not result.complete
    assert replay_economic_trades(Position(D(0), None), [trade("buy", "3", "4")]).complete


def test_oversell_rejected_without_epsilon_or_synthetic_opening():
    event = trade("sell", "1.000000000000000001", "10")
    with pytest.raises(AccountingError, match="不足"):
        apply_filled_trade(Position(D(1), D(10)), event)
    with pytest.raises(AccountingError, match="期初"):
        replay_economic_trades(Position(D(1), D(10)), [event])


def test_negative_diluted_cost_and_legacy_rounding_ties():
    assert rounded(D("-1.2345"), 3) == D("-1.234")
    assert rounded(D("1.2345"), 3) == D("1.235")
    result = apply_filled_trade(Position(D(10), D(1)), trade("sell", "5", "10"))
    assert result.position.cost == D(-8)


@pytest.mark.parametrize("invalid", [None, True, 0.1, "NaN", "Infinity", "-1", " 1", "1e1000"])
def test_exact_input_rejects_unavailable_nonfinite_and_float(invalid):
    with pytest.raises(AccountingError):
        number(invalid)


def test_mismatched_notional_and_mixed_currency_rejected():
    with pytest.raises(AccountingError, match="不一致"):
        trade("buy", "2", "3", amount="7")
    with pytest.raises(AccountingError, match="不同原币"):
        replay_economic_trades(
            Position(D(0), D(0)), [trade("buy", "2", "3"), trade("buy", "2", "3", currency="HKD")]
        )


def test_decimal_context_cannot_change_accounting_result():
    events = [trade("buy", "3", "1", "1"), trade("sell", "1", "2")]
    with localcontext() as context:
        context.prec = 6
        low = replay_economic_trades(Position(D(0), D(0)), events)
    with localcontext() as context:
        context.prec = 50
        high = replay_economic_trades(Position(D(0), D(0)), events)
    assert low == high
    assert low.complete


def test_maximum_with_tiny_fraction_and_explicit_settlement_are_exact():
    with pytest.raises(AccountingError):
        number("9007199254740991.000000000000000001")
    event = trade("buy", "1", "1", net="9007199254740990.000000000000000001")
    assert str(cash_delta(event)) == "-9007199254740990.000000000000000001"


def test_supported_minimum_quantity_is_retained_and_excess_precision_rejected():
    event = trade("buy", "0.000000000000000001", "1")
    result = apply_filled_trade(Position(D(1), D(1)), event)
    assert result.position.quantity == D("1.000000000000000001")
    with pytest.raises(AccountingError, match="精度"):
        trade("buy", "1e-80", "1")
