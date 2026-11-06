"""Exact financial primitives; persistence and authorization belong to domain services.

Broker diluted cost and economic moving-average cost are deliberately distinct.
Recorded dividend amounts and cross-currency settlements are never reconstructed.
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_DOWN, ROUND_HALF_UP, Decimal, InvalidOperation, localcontext
from typing import Literal

ZERO = Decimal(0)
MAX_VALUE = Decimal(9007199254740991)


class AccountingError(ValueError):
    pass


def number(value: Decimal | str | int, *, negative: bool = False) -> Decimal:
    # Floats have already lost the original decimal bytes; reject rather than guess.
    if isinstance(value, bool) or not isinstance(value, (Decimal, str, int)):
        raise AccountingError("金额必须为精确十进制数")
    if isinstance(value, str) and (len(value) > 96 or value.strip() != value):
        raise AccountingError("金额格式无效")
    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError):
        raise AccountingError("金额格式无效") from None
    if not result.is_finite() or result.copy_abs() > MAX_VALUE or (result < 0 and not negative):
        raise AccountingError("金额超出精确记账范围")
    if result.as_tuple().exponent < -18:
        raise AccountingError("金额精度超出范围")
    return result


def rounded(value: Decimal, places: int) -> Decimal:
    # Preserve the legacy Math.round tie direction, including negative diluted cost.
    quantum = Decimal(1).scaleb(-places)
    with localcontext() as context:
        context.prec = 80
        return value.quantize(quantum, rounding=ROUND_HALF_UP if value >= 0 else ROUND_HALF_DOWN)


@dataclass(frozen=True)
class Position:
    quantity: Decimal
    cost: Decimal | None

    def __post_init__(self):
        object.__setattr__(self, "quantity", number(self.quantity))
        if self.cost is not None:
            object.__setattr__(self, "cost", number(self.cost, negative=True))


@dataclass(frozen=True)
class FilledTrade:
    side: Literal["buy", "sell", "dividend"]
    quantity: Decimal
    price: Decimal
    fees: Decimal | None
    amount: Decimal
    currency: str
    settlement_currency: str
    settlement_amount: Decimal | None = None

    def __post_init__(self):
        if self.side not in ("buy", "sell", "dividend"):
            raise AccountingError("成交方向无效")
        for field in ("quantity", "price", "amount"):
            object.__setattr__(self, field, number(getattr(self, field)))
        for field in ("fees", "settlement_amount"):
            if getattr(self, field) is not None:
                object.__setattr__(self, field, number(getattr(self, field)))
        if self.side != "dividend" and self.quantity <= 0:
            raise AccountingError("成交数量必须大于零")
        for currency in (self.currency, self.settlement_currency):
            if (
                len(currency) != 3
                or not currency.isascii()
                or not currency.isalpha()
                or currency != currency.upper()
            ):
                raise AccountingError("币种无效")
        if self.side != "dividend":
            with localcontext() as context:
                context.prec = 80
                if self.amount != self.quantity * self.price:
                    raise AccountingError("成交金额与数量价格不一致")


def cash_delta(trade: FilledTrade) -> Decimal | None:
    """Signed cash in settlement currency. Missing FX/fees stay unavailable."""
    if trade.settlement_amount is not None:
        return trade.settlement_amount.copy_negate() if trade.side == "buy" else trade.settlement_amount
    if trade.currency != trade.settlement_currency or trade.fees is None:
        return None
    with localcontext() as context:
        context.prec = 80
        return -(trade.amount + trade.fees) if trade.side == "buy" else trade.amount - trade.fees


@dataclass(frozen=True)
class AccountingResult:
    position: Position
    realized_pnl: Decimal | None
    cash: Decimal | None
    cash_currency: str


def apply_filled_trade(position: Position, trade: FilledTrade) -> AccountingResult:
    """Broker displayed cost, not a cumulative economic P&L measure."""
    with localcontext() as context:
        context.prec = 80
        cash = cash_delta(trade)
        if trade.side == "dividend":
            pnl = None if trade.fees is None else rounded(trade.amount - trade.fees, 2)
            return AccountingResult(position, pnl, cash, trade.settlement_currency)
        if trade.side == "buy":
            qty = position.quantity + trade.quantity
            cost = (
                None
                if position.cost is None or trade.fees is None
                else rounded((position.quantity * position.cost + trade.amount + trade.fees) / qty, 3)
            )
            return AccountingResult(Position(qty, cost), None, cash, trade.settlement_currency)
        if trade.quantity > position.quantity:
            raise AccountingError("可卖数量不足")
        qty = position.quantity - trade.quantity
        cost = (
            ZERO
            if qty == 0
            else None
            if position.cost is None
            else rounded((position.quantity * position.cost - trade.amount) / qty, 3)
        )
        pnl = (
            None
            if position.cost is None or trade.fees is None
            else rounded(trade.amount - position.cost * trade.quantity - trade.fees, 2)
        )
        return AccountingResult(Position(qty, cost), pnl, cash, trade.settlement_currency)


@dataclass(frozen=True)
class EconomicPosition:
    """Computed moving-average projection; its recurring quotient is not an input amount."""

    quantity: Decimal
    cost: Decimal | None


@dataclass(frozen=True)
class EconomicResult:
    position: EconomicPosition
    realized_pnl: Decimal | None
    complete: bool


def replay_economic_trades(initial: Position, trades: list[FilledTrade], *, on_step=None) -> EconomicResult:
    """Caller supplies verified chronological filled events for one owner/position.

    Unknown opening/fees makes aggregate P&L unknown even after liquidation;
    a later purchase may establish a new known position without repairing history.
    """
    with localcontext() as context:
        context.prec = 80
        qty, average = initial.quantity, initial.cost
        if qty == 0:
            average = ZERO
        complete = average is not None
        realized = ZERO
        currency = None
        for trade in trades:
            if currency is not None and trade.currency != currency:
                raise AccountingError("不可混合不同原币账本")
            currency = trade.currency
            if trade.fees is None:
                complete = False
            if trade.side == "dividend":
                if trade.fees is not None:
                    realized += trade.amount - trade.fees
            elif trade.side == "buy":
                total = qty + trade.quantity
                average = (
                    None
                    if average is None or trade.fees is None
                    else (qty * average + trade.amount + trade.fees) / total
                )
                qty = total
            else:
                if trade.quantity > qty:
                    raise AccountingError("历史成交超卖，不能从当前持仓补造期初")
                if average is None or trade.fees is None:
                    complete = False
                else:
                    realized += trade.amount - average * trade.quantity - trade.fees
                qty -= trade.quantity
                if qty == 0:
                    average = ZERO
            if on_step is not None:
                on_step(
                    EconomicResult(EconomicPosition(qty, average), realized if complete else None, complete)
                )
        return EconomicResult(EconomicPosition(qty, average), realized if complete else None, complete)
