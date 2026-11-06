import { getSiteSettings } from "@/lib/settings";
import { getDb } from "@/lib/db";
import { getAssets, type AssetType } from "@/lib/assets";
import { createHash } from "node:crypto";
export const CATALOG_TYPES = [
  "market",
  "stock",
  "crypto",
  "metal",
  "flag",
  "broker",
  "card",
  "icon",
] as const;
const KEY = "assetLibraryCatalog";
export type CatalogPreferences = {
  removed: string[];
  brokerMarkets: Record<string, string[]>;
  brokerOrder: string[];
};
export function readCatalogPreferences() {
  const row = getDb()
    .prepare("SELECT value FROM site_settings WHERE key = ?")
    .get(KEY) as
    | {
        value: string;
      }
    | undefined;
  let raw: Partial<CatalogPreferences> = {};
  try {
    raw = JSON.parse(row?.value || "{}");
  } catch {}
  return {
    removed: Array.isArray(raw.removed) ? raw.removed : [],
    brokerMarkets: raw.brokerMarkets || {},
    brokerOrder: Array.isArray(raw.brokerOrder) ? raw.brokerOrder : [],
    revision: createHash("sha256")
      .update(row?.value || "{}")
      .digest("hex"),
  };
}
export function changeCatalog(input: {
  revision: string;
  action: string;
  ids: string[];
  markets?: string[];
}) {
  const db = getDb();
  return db.transaction(() => {
    const current = readCatalogPreferences();
    if (input.revision !== current.revision)
      throw Error("素材目录已变化，请刷新后重试");
    const known = new Set(getAssets().filter(a=>a.type!=="group").map((a) => a.id));
    if (
      !input.ids.length ||
      input.ids.length > 100 ||
      input.ids.some((id) => !known.has(id))
    )
      throw Error("素材选择已失效");
    const next: CatalogPreferences = {
      removed: [...current.removed],
      brokerMarkets: { ...current.brokerMarkets },
      brokerOrder: [...current.brokerOrder],
    };
    if (input.action === "remove")
      next.removed = [...new Set([...next.removed, ...input.ids])];
    else if (input.action === "restore")
      next.removed = next.removed.filter((id) => !input.ids.includes(id));
    else if (input.action === "classify") {
      const brokers = new Set(getAssets("broker").map((a) => a.id));
      if (input.ids.some((id) => !brokers.has(id)))
        throw Error("仅券商素材支持市场分类");
      const allowed = new Set([
        "US",
        "HK",
        "CN",
        "JP",
        "KR",
        "SG",
        "UK",
        "DE",
        "FR",
        "AU",
        "CA",
        "IN",
        "TW",
        "BR",
      ]);
      if (
        !Array.isArray(input.markets) ||
        input.markets.some((m) => !allowed.has(m))
      )
        throw Error("市场分类无效");
      for (const id of input.ids)
        next.brokerMarkets[id] = [...new Set(input.markets)];
    } else if (input.action === "order") {
      const brokers = new Set(getAssets("broker").map((a) => a.id));
      if (input.ids.some((id) => !brokers.has(id))) throw Error("券商排序无效");
      const rows = getAssets("broker").sort(
        (a, b) =>
          (current.brokerOrder.indexOf(a.id) < 0
            ? 1e6
            : current.brokerOrder.indexOf(a.id)) -
            (current.brokerOrder.indexOf(b.id) < 0
              ? 1e6
              : current.brokerOrder.indexOf(b.id)) ||
          a.name.localeCompare(b.name),
      );
      const selected = new Set(input.ids);
      let index = 0;
      next.brokerOrder = rows.map((row) =>
        selected.has(row.id) ? input.ids[index++] : row.id,
      );
    } else throw Error("不支持的操作");
    db.prepare(
      "INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(KEY, JSON.stringify(next));
    return readCatalogPreferences();
  })();
}
export function readCatalog(
  type: AssetType,
  market: string,
  q: string,
  page: number,
  removed: boolean,
) {
  const prefs = readCatalogPreferences(),
    search = q.trim().toLocaleLowerCase();
  const all = getAssets(type);
  const marketCounts: Record<string, number> = {};
  if (type === "stock")
    for (const asset of all) {
      if (
        prefs.removed.includes(asset.id) !== removed ||
        !(asset.url || asset.urlDark)
      )
        continue;
      marketCounts[asset.market] = (marketCounts[asset.market] || 0) + 1;
    }
  let rows = all.filter(
    (a) =>
      prefs.removed.includes(a.id) === removed &&
      (!market ||
        market === "ALL" ||
        (type === "broker"
          ? prefs.brokerMarkets[a.id]?.includes(market)
          : a.market === market)) &&
      (!search ||
        `${a.name} ${a.code} ${a.market}`.toLocaleLowerCase().includes(search)),
  );
  const marketOrder = [
    ...getSiteSettings().assetMarketOrder,
    ...[
      "US",
      "HK",
      "CN",
      "JP",
      "KR",
      "SG",
      "UK",
      "DE",
      "FR",
      "AU",
      "CA",
      "IN",
      "TW",
      "BR",
    ],
  ];
  rows.sort((a, b) =>
    type === "market"
      ? (marketOrder.indexOf(a.market) < 0
          ? 1e6
          : marketOrder.indexOf(a.market)) -
        (marketOrder.indexOf(b.market) < 0
          ? 1e6
          : marketOrder.indexOf(b.market))
      : type === "broker"
        ? (prefs.brokerOrder.indexOf(a.id) < 0
            ? 1e6
            : prefs.brokerOrder.indexOf(a.id)) -
            (prefs.brokerOrder.indexOf(b.id) < 0
              ? 1e6
              : prefs.brokerOrder.indexOf(b.id)) || a.name.localeCompare(b.name)
        : a.code.localeCompare(b.code),
  );
  const total = rows.length,
    safe = Math.min(
      Math.max(1, Math.floor(page) || 1),
      Math.max(1, Math.ceil(total / 10)),
    );
  // Directory responses deliberately contain no quote fields and never call a quote provider.
  return {
    assets: rows
      .slice((safe - 1) * 10, safe * 10)
      .map(
        ({
          id,
          type,
          market,
          code,
          name,
          url,
          urlDark,
          imageUrl,
          imageUrlDark,
        }) => ({
          id,
          type,
          market,
          code,
          name,
          url,
          urlDark,
          imageUrl,
          imageUrlDark,
          brokerMarkets: prefs.brokerMarkets[id] || [],
        }),
      ),
    total,
    removedCount: all.filter((asset) => prefs.removed.includes(asset.id))
      .length,
    marketCounts,
    page: safe,
    pageSize: 10,
    revision: prefs.revision,
  };
}
