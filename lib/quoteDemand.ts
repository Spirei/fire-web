import { normalizeMarketCode } from "./marketCode";
import type { QuoteItem } from "./quotes";

export const QUOTE_DEMAND_MARKETS = ["US", "HK", "CN", "JP", "KR", "ASSET"] as const;
export const QUOTE_DEMAND_IDLE_MS = 7 * 24 * 60 * 60 * 1_000;
export const QUOTE_DEMAND_HOT_MS = 90_000;
export const QUOTE_USER_LIMIT = 256;

/** Aggregated public demand only; never includes a subscriber/account identifier. */
export interface PublicQuoteDemand { item: QuoteItem; requestedAt?: number; reads?: number }

export function publicQuoteItems(items: QuoteItem[]): QuoteItem[] {
  const unique = new Map<string, QuoteItem>();
  for (const input of items) {
    if (!QUOTE_DEMAND_MARKETS.includes(input.market as typeof QUOTE_DEMAND_MARKETS[number])) continue;
    const code = normalizeMarketCode(input.market, input.code);
    if (!/^[A-Z0-9._-]{1,40}$/.test(code)) continue;
    const id = JSON.stringify([input.market, code]);
    unique.set(id, { id, market: input.market, code });
  }
  return [...unique.values()];
}

export function quoteSubscriptionsDiscovery() {
  return { version: 1, path: "/api/v2/quote-subscriptions", read_scope: "portfolio.read", write_scope: "portfolio.write",
    markets: QUOTE_DEMAND_MARKETS, max_items_per_request: 100, max_subscriptions: QUOTE_USER_LIMIT,
    idle_expires_in: QUOTE_DEMAND_IDLE_MS / 1_000, hot_lease_seconds: QUOTE_DEMAND_HOT_MS / 1_000,
    automatic_on_quote_read: true, persistent: true, cancellation_changes_portfolio: false };
}
