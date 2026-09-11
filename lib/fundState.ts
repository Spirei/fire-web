import { cardCashByCurrency } from "./cardLibrary";
import { fundBalances, fundSummaries } from "./funds";

/**
 * 资金系统返回给前端的现金口径（balances / summaries）+ 银行卡现金明细。
 *
 * 为什么要有这一层：卡面库「我的卡」里的**借记卡 / 预付卡**余额也是现金，
 * 必须和资金账本的现金算在一起，否则资产分析的可用现金 / 净资产、资金系统的期末总资产、
 * 我的持仓的总资产会各说各话。所以 /api/v1/funds 的读、写、删三个出口都走这里，
 * 保证任何一次响应里的 balances 都是同一个口径。
 *
 * 卡余额为什么还要并进「其他净流入」：资金系统的等式是
 * 「盈亏额 = 期末总资产 − 期初总资产 − 当期净投入」。只把它加进期末总资产的话，
 * 卡里的钱会被当成投资收益（凭空多出来的盈利）；并进其他净流入后等式依旧成立，
 * 语义上也对 —— 这笔钱确实是从账本外面流进来的。
 */

export type BalanceMap = Record<string, number>;

export interface FundSummaryRow {
  openingAsset: number;
  cashNetFlow: number;
  stockNetFlow: number;
  otherNetFlow: number;
}

export type SummaryMap = Record<string, FundSummaryRow>;

export interface FundState {
  balances: BalanceMap;
  summaries: SummaryMap;
  /** 原始卡余额明细（按卡币种），前端用来展示「银行卡现金」这一项 */
  cardCash: BalanceMap;
}

export function fundState(userId: string): FundState {
  const balances = fundBalances(userId) as BalanceMap;
  const summaries = fundSummaries(userId) as SummaryMap;
  const cardCash = cardCashByCurrency(userId);
  Object.entries(cardCash).forEach(([currency, amount]) => {
    if (!Number.isFinite(amount) || amount === 0) return;
    balances[currency] = (balances[currency] || 0) + amount;
    const summary = summaries[currency];
    if (summary) summary.otherNetFlow += amount;
    else summaries[currency] = { openingAsset: 0, cashNetFlow: 0, stockNetFlow: 0, otherNetFlow: amount };
  });
  return { balances, summaries, cardCash };
}
