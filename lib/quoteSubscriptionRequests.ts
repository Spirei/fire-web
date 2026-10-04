import type { QuoteItem } from "./quotes";
import type { QuoteSubscriptionService } from "./quoteSubscriptionService";

/** Delete only this owner's leases; do not start the scheduler from account management. */
export function releaseUserQuoteSubscriptions(userId: string) {
  const service = (globalThis as typeof globalThis & { __alcorQuoteSubscriptionsV1?: QuoteSubscriptionService }).__alcorQuoteSubscriptionsV1;
  try { service?.remove(userId); } catch { /* The database DELETE still cascades private leases. */ }
}

/** Load private persistence only for authenticated demand; anonymous/history reads stay light. */
export async function quoteSubscriptionService(): Promise<QuoteSubscriptionService> {
  const [{ getDb }, { QuoteSubscriptionsStore }, { QuoteSubscriptionService }, quotes] = await Promise.all([
    import("./db"), import("./quoteSubscriptionsStore"), import("./quoteSubscriptionService"), import("./quotes")
  ]);
  const host = globalThis as typeof globalThis & { __alcorQuoteSubscriptionsV1?: QuoteSubscriptionService };
  let store: InstanceType<typeof QuoteSubscriptionsStore> | undefined;
  const callbacks = { store: () => store ??= new QuoteSubscriptionsStore(getDb()),
    namespace: quotes.quoteDemandNamespace, sync: quotes.syncQuoteSubscriptions };
  const service = host.__alcorQuoteSubscriptionsV1 ??= new QuoteSubscriptionService(callbacks);
  service.configure(callbacks);
  return service;
}

export async function trackQuoteRequest(request: Request, items: QuoteItem[]): Promise<boolean> {
  if (!items.length) return false;
  const cookie = request.headers.get("cookie") || "";
  if (!request.headers.has("authorization") && !/(?:^|;\s*)(?:fire_session|stocklog_session)=/.test(cookie)) return false;
  try {
    const { getAuthUser, isTrustedMutationRequest } = await import("./auth");
    if (!isTrustedMutationRequest(request) || !getAuthUser(request)) return false;
    const service = await quoteSubscriptionService();
    // Loading modules/body can yield. Recheck the live identity immediately before persistence.
    const user = getAuthUser(request);
    if (!user) return false;
    service.observe(user.id, items); return true;
  } catch {
    // Demand bookkeeping failure must not turn a public quote read into a market outage.
    return false;
  }
}
