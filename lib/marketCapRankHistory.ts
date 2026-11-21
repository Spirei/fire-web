import { marketCapStockKey, type RankedAsset } from "./marketCapIcons";

type Ranks = Record<string, number | null>;
type RankSnapshot = { at: number; ranks: Ranks };
type RankHistory = { latest: RankSnapshot; previous?: RankSnapshot };

function isRankSnapshot(value: unknown): value is RankSnapshot {
  if (!value || typeof value !== "object") return false;
  const { at, ranks } = value as Partial<RankSnapshot>;
  return typeof at === "number" && Number.isFinite(new Date(at).getTime()) && !!ranks && typeof ranks === "object" && !Array.isArray(ranks);
}

function rankKey(item: RankedAsset): string | null {
  if (item.type === "crypto" || item.type === "metal") {
    const code = item.code.trim().toUpperCase();
    return code ? `${item.type}:${code}` : null;
  }
  const stock = marketCapStockKey(item);
  return stock ? `stock:${stock.market}:${stock.code}` : null;
}

export function compareMarketCapRanks(items: RankedAsset[], at: number, saved: unknown) {
  const changes: (number | null)[] = items.map(() => null);
  const stored = saved as Partial<RankHistory> | null;
  const latest = isRankSnapshot(stored?.latest) ? stored.latest : undefined;
  if (!Number.isFinite(at) || (latest && at < latest.at)) return { changes };

  const keys = items.map(rankKey);
  const ranks: Ranks = {};
  keys.forEach((key, index) => {
    // Both rows are ambiguous when multiple entries refer to the same instrument.
    if (key) ranks[key] = Object.hasOwn(ranks, key) ? null : index + 1;
  });
  const previous = latest && at > latest.at ? latest : stored?.previous;
  const baseline = isRankSnapshot(previous) && previous.at < at ? previous : undefined;
  if (baseline) {
    keys.forEach((key, index) => {
      if (!key || ranks[key] === null || !Object.hasOwn(baseline.ranks, key)) return;
      const prior = baseline.ranks[key];
      if (typeof prior === "number" && Number.isSafeInteger(prior) && prior > 0) changes[index] = prior - (index + 1);
    });
  }
  const history: RankHistory = { latest: { at, ranks }, previous: baseline };
  return { changes, history, comparedAt: baseline?.at };
}
