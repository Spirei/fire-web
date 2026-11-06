"""Pure legacy JSON order projection; no account guesses or currency conversion."""
from .trading import MARKET_CURRENCY


def personal_order_rows(data):
    def text(value):
        return '' if value is None else str(value)
    rows=[]
    for item in data.get('tradeOrders',[]):
        if item.get('status')!='filled':
            continue
        market=text(item.get('market')).strip().upper()
        rows.append({
            '订单状态':'已成交','市场':market,'股票代码':text(item.get('code')),
            '方向':{'buy':'买入','sell':'卖出'}.get(item.get('side'),''),
            '成交数量':text(item.get('qty')),'成交均价':text(item.get('price')),
            '费用':text(item.get('fees')),'委托时间':text(item.get('traded_at')),
            '成交金额':text(item.get('amount')),'订单号':text(item.get('order_no')),
            # The old JSON schema has no price-currency field. Its explicit
            # market uses the same fixed denomination contract as old orders;
            # unknown markets stay unknown, never use a mapped account default.
            '币种':MARKET_CURRENCY.get(market,''),'原币依据':'legacy_market_contract',
            '结算币种':text(item.get('settlement_currency')),
            '实际结算净额':text(item.get('settlement_amount')),
        })
    return rows
