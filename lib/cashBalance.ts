import { getDb } from "./db";
import { cardCashByCurrency } from "./cardLibrary";
import { createFundTransaction, readFundBalances, type FundTransaction } from "./funds";
import { isFundCurrency } from "./fundCurrencies";

/** Reconcile a native cash balance through an auditable ledger adjustment. */
export function setCashBalance(userId: string, currency: unknown, target: unknown, expected: unknown): { error: string; status: 400 | 409 } | { transaction: FundTransaction | null } {
  if (typeof currency !== "string" || !isFundCurrency(currency) || typeof target !== "number" || !Number.isFinite(target) || target < 0 || target > 1e12 || typeof expected !== "number" || !Number.isFinite(expected)) {
    return { error: "现金余额参数无效", status: 400 } as const;
  }
  return getDb().transaction(() => {
    const current = readFundBalances(userId)[currency] + (cardCashByCurrency(userId, true)[currency] ?? 0);
    if (!Number.isFinite(current)) return { error: "现金来源异常，请先核对资金与银行卡记录", status: 409 } as const;
    // An unchanged target (including a retried successful save) never adds a second entry.
    if (Math.abs(current - target) < 1e-8) return { transaction: null };
    if (Math.abs(current - expected) > 1e-8) return { error: "现金余额已变化，请重新打开并核对后保存", status: 409 } as const;
    const delta = target - current;
    if (Math.abs(delta) > 1e12) return { error: "余额调整金额超出范围", status: 400 } as const;
    const transaction = createFundTransaction({ userId, currency, type: "adjustment", amount: Math.abs(delta), direction: delta > 0 ? 1 : -1, note: "资产页可用现金核对调整" });
    return { transaction };
  })();
}
