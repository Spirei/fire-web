import { getDb } from "./db";
import { readFundBalances } from "./funds";
import { cardCashByCurrency } from "./cardLibrary";
import { getSimpleLedger } from "./simpleStore";
import { investmentEquities, type AccountCashSnapshot } from "./accountCash";

/** One consistent user-owned snapshot; no cash repair or other business writes. */
export function readAccountCash(userId: string): AccountCashSnapshot {
  return getDb().transaction(() => {
    const balances: Record<string, number> = readFundBalances(userId);
    const cardCash = cardCashByCurrency(userId, true);
    for (const [code, amount] of Object.entries(cardCash)) balances[code] = (balances[code] ?? 0) + amount;
    try {
      const parsed = investmentEquities(getSimpleLedger(userId, true).invest);
      return { balances, cardCash, investmentEquities: parsed.equities, sourceComplete: parsed.complete };
    } catch {
      // Corrupt/missing source is not a valid zero-cash snapshot.
      return { balances, cardCash, investmentEquities: [], sourceComplete: false };
    }
  })();
}
