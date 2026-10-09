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
      // Imported equity never contributes cash or imposes a fabricated opening
      // requirement on independently recorded bank balances and filled-order proceeds.
      const missingOpeningCurrencies: string[] = [];
      if (!parsed.complete) balances.UNKNOWN = Number.NaN;
      const unavailableReasons = [...(!parsed.complete ? ["invalid_imported_equity_source"] : []), ...(Object.values(balances).some(value => !Number.isFinite(value)) ? ["invalid_cash_balance_source"] : [])];
      return { balances, cardCash, investmentEquities: parsed.equities, sourceComplete: parsed.complete && unavailableReasons.length === 0, unavailableReasons, missingOpeningCurrencies };
    } catch {
      // Corrupt/missing source is not a valid zero-cash snapshot.
      balances.UNKNOWN = Number.NaN;
      return { balances, cardCash, investmentEquities: [], sourceComplete: false, unavailableReasons: ["invalid_imported_equity_source"], missingOpeningCurrencies: [] };
    }
  })();
}
