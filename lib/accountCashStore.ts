import { getDb } from "./db";
import { readFundBalances } from "./funds";
import { cardCashByCurrency } from "./cardLibrary";
import { getSimpleLedger } from "./simpleStore";
import { investmentEquities, ACCOUNT_MARKET_CURRENCY, type AccountCashSnapshot } from "./accountCash";

/** One consistent user-owned snapshot; no cash repair or other business writes. */
export function readAccountCash(userId: string): AccountCashSnapshot {
  return getDb().transaction(() => {
    const balances: Record<string, number> = readFundBalances(userId);
    const cardCash = cardCashByCurrency(userId, true);
    for (const [code, amount] of Object.entries(cardCash)) balances[code] = (balances[code] ?? 0) + amount;
    try {
      const parsed = investmentEquities(getSimpleLedger(userId, true).invest);
      // Imported total equity is not an opening cash balance. Without an explicit
      // owner-recorded cash opening, its cash component and historical funding are unknown.
      const openings = new Set((getDb().prepare("SELECT DISTINCT currency FROM fund_transactions WHERE user_id=? AND type='opening' AND id NOT LIKE 'fund-order-%' AND id NOT LIKE 'card-link-%' AND amount>0 AND direction IN (-1,1)").all(userId) as {currency:string}[]).map(row => row.currency));
      const missingOpeningCurrencies = [...new Set(parsed.equities.map(row => ACCOUNT_MARKET_CURRENCY[row.market] ?? row.cur).filter(code => !openings.has(code)))].sort();
      if (!parsed.complete) balances.UNKNOWN = Number.NaN;
      for (const code of missingOpeningCurrencies) balances[code] = Number.NaN;
      const unavailableReasons = [...(!parsed.complete ? ["invalid_imported_equity_source"] : []), ...(missingOpeningCurrencies.length ? ["missing_explicit_opening_cash_for_imported_equity"] : []), ...(Object.values(balances).some(value => !Number.isFinite(value)) && !missingOpeningCurrencies.length ? ["invalid_cash_balance_source"] : [])];
      return { balances, cardCash, investmentEquities: parsed.equities, sourceComplete: parsed.complete && unavailableReasons.length === 0, unavailableReasons, missingOpeningCurrencies };
    } catch {
      // Corrupt/missing source is not a valid zero-cash snapshot.
      balances.UNKNOWN = Number.NaN;
      return { balances, cardCash, investmentEquities: [], sourceComplete: false, unavailableReasons: ["invalid_imported_equity_source"], missingOpeningCurrencies: [] };
    }
  })();
}
