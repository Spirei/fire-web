"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { applyRelatedEtfMainStockIcons, pickStockIcon, stockIconLookupCodes } from "@/lib/stockIconKey";

import { stockIconBatches } from '@/lib/stockIconRequests';

export interface Asset {
  id: string;
  type: "stock" | "market" | "flag" | "broker" | "crypto" | "metal" | "group" | "card";
  market: string;
  code: string;
  name: string;
  url: string;
  urlDark?: string;
  imageUrl?: string;
  imageUrlDark?: string;
  marketCap: number;
  price: number | null;
  changePct: number | null;
  source: "auto" | "manual";
  lastCheckedAt: string;
  board: string;
  updatedAt: string;
}

type AssetType = Exclude<Asset["type"], "group" | "card">;
type HookOptions = {
  /** 服务端已经读取设置时直接注入，避免再次请求 /api/settings。 */
  stockIconCdn?: boolean;
  /** 仅确实需要 CDN 开关的组件才读取设置。 */
  loadCdnSetting?: boolean;
  /** 素材库等需要完整 3000+ 股票图标时才拉全量；持仓/首页只用预热或本地缓存。 */
  fullCatalog?: boolean;
};

const ALL_TYPES: AssetType[] = ["stock", "market", "flag", "broker", "crypto", "metal"];
const CACHE_TTL = 5 * 60 * 1000;
// Stock icon URLs carry a content version. A stale cached URL can outlive the
// file it points to, so bumping this discards old stock icon maps instead of
// rendering their now-missing images.
const CACHE_VERSION = 5;
const cache = new Map<AssetType, { assets: Asset[]; at: number }>();
const inflight = new Map<AssetType, Promise<void>>();
const listeners = new Set<() => void>();
const subscribedTypes = new Set<AssetType>();
let fullStockCatalog = false;
const cdnListeners = new Set<(value: boolean) => void>();
let cdnEnabled = false;
let cdnLoaded = false;
let cdnInflight: Promise<void> | null = null;
let cdnRequested = false;

/**
 * 用服务端首屏注入的紧凑图标表预热共享缓存。
 * at 保持 0，让完整素材库仍会在后台刷新；首帧则无需等待 /api/assets。
 */
const iconInflight = new Map<string, Promise<void>>();
const subscribedStockPairs = new Map<string, { market: string; code: string }>();

function stockMapFromCache(): Record<string, string> {
  const map: Record<string, string> = {};
  (cache.get("stock")?.assets ?? []).forEach((asset) => {
    map[`${asset.market.toUpperCase()}:${asset.code.toUpperCase()}`] = asset.imageUrl || asset.url;
  });
  return applyRelatedEtfMainStockIcons(map);
}

function applyStockIconPayload(data: { assets?: Array<{ type?: string; market?: string; code?: string; url?: string; imageUrl?: string }> } | null, keys: string[], force: boolean) {
  if (!Array.isArray(data?.assets)) return;
  const icons: Record<string, string> = {};
  (Array.isArray(data?.assets) ? data.assets : []).forEach((asset) => {
    if (asset?.type === "stock" && asset.market && asset.code && (asset.imageUrl || asset.url)) {
      icons[`${asset.market.toUpperCase()}:${asset.code.toUpperCase()}`] = asset.imageUrl || asset.url || "";
    }
  });
  if (force) {
    const requested = new Set(keys.flatMap(key => {
      const separator = key.indexOf(':');
      const market = key.slice(0, separator);
      return stockIconLookupCodes(market, key.slice(separator + 1)).map(code => `${market}:${code}`);
    }));
    const current = cache.get('stock');
    if (current) cache.set('stock', { ...current, assets: current.assets.filter(asset => !requested.has(`${asset.market.toUpperCase()}:${asset.code.toUpperCase()}`) || !!pickStockIcon(icons, asset.market, asset.code)) });
  }
  if (Object.keys(icons).length) primeStockIconCache(icons);
  if (force || Object.keys(icons).length) {
    saveLocalType('stock', cache.get('stock')?.assets ?? []);
    notify();
  }
}

/** 财报日历等一次补多张素材库图标，不拉 3000+ 全量。 */
export function ensureStockIcons(pairs: Array<{ market: string; code: string }>, force = false): Promise<void> | undefined {
  for (const pair of pairs) {
    const market = pair.market.trim().toUpperCase(), code = pair.code.trim().toUpperCase();
    if (market && market !== 'ASSET' && code) subscribedStockPairs.set(`${market}:${code}`, { market, code });
  }
  const cached = stockMapFromCache();
  const missing = pairs.filter(pair => force || !pickStockIcon(cached, pair.market, pair.code));
  const batches = stockIconBatches(missing);
  if (!batches.length) return;
  const tasks = batches.map(keys => {
    const batchKey = keys.slice().sort().join(',');
    const pending = iconInflight.get(batchKey);
    if (pending) return force ? pending.then(() => ensureStockIcons(keys.map(key => {
      const separator = key.indexOf(':');
      return { market: key.slice(0, separator), code: key.slice(separator + 1) };
    }), true)) : pending;
    const task = fetch(`/api/assets?type=stock&keys=${encodeURIComponent(keys.join(','))}`, force ? { cache: 'no-store' } : undefined)
      .then(response => response.ok ? response.json() : null)
      .then(data => applyStockIconPayload(data, keys, force))
      .catch(() => { /* 保留已有首字母兜底 */ })
      .finally(() => { if (iconInflight.get(batchKey) === task) iconInflight.delete(batchKey); });
    iconInflight.set(batchKey, task);
    return task;
  });
  return Promise.all(tasks).then(() => undefined);
}

/** 个股详情 / 划过卡片按需补一张素材库图标，不拉 3000+ 全量。 */
export function ensureStockIcon(market: string, code: string, force = false) {
  return ensureStockIcons([{ market, code }], force);
}

export function primeStockIconCache(icons: Record<string, string>) {
  if (!Object.keys(icons).length) return;
  const current = cache.get("stock");
  const byKey = new Map<string, Asset>();
  (current?.assets ?? []).forEach((asset) => byKey.set(`${asset.market.toUpperCase()}:${asset.code.toUpperCase()}`, asset));
  Object.entries(icons).forEach(([rawKey, url]) => {
    if (!url) return;
    const separator = rawKey.indexOf(":");
    if (separator <= 0) return;
    const market = rawKey.slice(0, separator).toUpperCase();
    const code = rawKey.slice(separator + 1).toUpperCase();
    const key = `${market}:${code}`;
    if ((byKey.get(key)?.imageUrl || byKey.get(key)?.url) === url) return;
    byKey.set(key, {
      id: `stock:${key}`,
      type: "stock",
      market,
      code,
      name: code,
      url,
      marketCap: 0,
      price: null,
      changePct: null,
      source: "auto",
      lastCheckedAt: "",
      board: "",
      updatedAt: ""
    });
  });
  cache.set("stock", { assets: [...byKey.values()], at: current?.at ?? 0 });
}

/** 服务端首屏注入的市场图标表：渲染期预热，市场下拉 / 筛选首帧就是素材库图标（at 保持 0 让完整列表后台刷新） */
export function primeMarketIconCache(icons: Record<string, string>) {
  if (!Object.keys(icons).length) return;
  const current = cache.get("market");
  const byKey = new Map<string, Asset>();
  (current?.assets ?? []).forEach((asset) => byKey.set(asset.market.toUpperCase(), asset));
  Object.entries(icons).forEach(([rawKey, url]) => {
    if (!url) return;
    const key = rawKey.trim().toUpperCase();
    if (!key || byKey.has(key)) return;
    byKey.set(key, {
      id: `market:${key}`,
      type: "market",
      market: key,
      code: key,
      name: key,
      url,
      marketCap: 0,
      price: null,
      changePct: null,
      source: "auto",
      lastCheckedAt: "",
      board: "",
      updatedAt: ""
    });
  });
  cache.set("market", { assets: [...byKey.values()], at: current?.at ?? 0 });
}

export function primeFlagIconCache(icons: Record<string, string>) {
  const current = cache.get("flag");
  const byKey = new Map<string, Asset>();
  (current?.assets ?? []).forEach((asset) => byKey.set(asset.code.toUpperCase(), asset));
  Object.entries(icons).forEach(([rawCode, url]) => {
    const code = rawCode.trim().toUpperCase();
    if (!code || !url) return;
    byKey.set(code, {
      id: `flag:${code}`, type: "flag", market: "", code, name: code, url,
      marketCap: 0, price: null, changePct: null, source: "auto", lastCheckedAt: "", board: "", updatedAt: ""
    });
  });
  cache.set("flag", { assets: [...byKey.values()], at: current?.at ?? 0 });
}

const flagInflight = new Map<string, Promise<void>>();
const flagCodeInflight = new Map<string, Promise<void>>();
const subscribedFlagCodes = new Set<string>();

/** 货币/地区组件按实际代码取素材库国旗，不再拉取全部 250 个条目。 */
export function ensureFlagIcons(codes: readonly string[], force = false) {
  const normalized = [...new Set(codes.map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)))];
  const existing = new Set((cache.get("flag")?.assets ?? []).map((asset) => asset.code.toUpperCase()));
  const missing = normalized.filter(code => (force || !existing.has(code)) && !flagCodeInflight.has(code));
  if (!missing.length) {
    const pending = [...new Set(normalized.map(code => flagCodeInflight.get(code)).filter((task): task is Promise<void> => !!task))];
    return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
  }
  const key = `${force ? "force:" : ""}${missing.slice().sort().join(",")}`;
  const pending = flagInflight.get(key);
  if (pending) return pending;
  const task = fetch(`/api/assets?type=flag&keys=${encodeURIComponent(missing.join(","))}`, force ? { cache: "no-store" } : undefined)
    .then((response) => response.ok ? response.json() : null)
    .then((data) => {
      const icons: Record<string, string> = {};
      (Array.isArray(data?.assets) ? data.assets : []).forEach((asset: Asset) => {
        if (asset.type === "flag" && asset.code && (asset.imageUrl || asset.url)) icons[asset.code.toUpperCase()] = asset.imageUrl || asset.url;
      });
      if (Object.keys(icons).length) {
        primeFlagIconCache(icons);
        notify();
      }
    })
    .catch(() => { /* 保留素材库内置路径兜底 */ })
    .finally(() => { flagInflight.delete(key); for (const code of missing) if (flagCodeInflight.get(code) === task) flagCodeInflight.delete(code); });
  flagInflight.set(key, task);
  missing.forEach(code => flagCodeInflight.set(code, task));
  return task;
}

export function useFlagIcon(code: string): string | undefined {
  const normalized = code.trim().toUpperCase();
  const read = () => (cache.get("flag")?.assets ?? []).find((asset) => asset.code.toUpperCase() === normalized)?.url;
  const [url, setUrl] = useState(read);
  useLayoutEffect(() => {
    if (!cache.has("flag")) {
      const saved = loadLocalType("flag");
      if (saved) cache.set("flag", saved);
    }
    setUrl(read());
  }, [normalized]);
  useEffect(() => {
    const update = () => setUrl(read());
    if (/^[A-Z]{2}$/.test(normalized)) subscribedFlagCodes.add(normalized);
    listeners.add(update);
    void ensureFlagIcons([normalized]);
    return () => {
      listeners.delete(update);
    };
  }, [normalized]);
  return url;
}

function cacheKey(type: AssetType) {
  return `fire:assets:cache:${type}`;
}

function normalizeTypes(types?: readonly AssetType[]): AssetType[] {
  const requested = types?.length ? types : ALL_TYPES;
  return [...new Set(requested)].sort() as AssetType[];
}

function loadLocalType(type: AssetType): { assets: Asset[]; at: number } | null {
  try {
    const raw = localStorage.getItem(cacheKey(type));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Asset[] | { assets?: Asset[]; at?: number; version?: number };
    // 兼容旧版仅保存数组的分类型缓存；时间记为 0，展示后立即后台刷新。
    const list = Array.isArray(parsed) ? parsed : parsed.assets;
    if (!Array.isArray(list)) return null;
    const fresh = !Array.isArray(parsed) && parsed.version === CACHE_VERSION;
    // Stock icons are fetched by exact keys, so an obsolete cached URL would
    // never be replaced by the normal refresh path. Drop it and use fresh data.
    if (type === "stock" && !fresh) return null;
    const assets = list.filter((asset) => asset.type === type);
    return { assets, at: fresh ? Number((parsed as { at?: number }).at) || 0 : 0 };
  } catch {
    return null;
  }
}

function saveLocalType(type: AssetType, assets: Asset[]) {
  try {
    localStorage.setItem(cacheKey(type), JSON.stringify({ assets, at: Date.now(), version: CACHE_VERSION }));
  } catch {
    /* 存储空间不足不影响页面 */
  }
}

function notify() {
  listeners.forEach((listener) => listener());
}

async function refreshType(type: AssetType, force = false) {
  const current = cache.get(type);
  if (type === "stock" && !force && !fullStockCatalog) return;
  if (!force && current && Date.now() - current.at < CACHE_TTL) return;
  const pending = inflight.get(type);
  if (pending && !force) return pending;

  let task!: Promise<void>;
  task = (async () => {
    try {
      const response = await fetch(`/api/assets?type=${encodeURIComponent(type)}`, force ? { cache: "no-store" } : undefined);
      const data = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(data?.assets)) return;
      const assets = (data.assets as Asset[]).filter((asset) => asset.type === type);
      cache.set(type, { assets, at: Date.now() });
      saveLocalType(type, assets);
      notify();
    } catch {
      /* 保留已有缓存与默认图标 */
    } finally {
      if (inflight.get(type) === task) inflight.delete(type);
    }
  })();
  inflight.set(type, task);
  return task;
}

async function refreshTypes(types: readonly AssetType[], force = false) {
  await Promise.all(types.map((type) => refreshType(type, force)));
}

function assetsFor(types: readonly AssetType[]) {
  return types.flatMap((type) => cache.get(type)?.assets ?? []);
}

function publishCdn(value: boolean) {
  cdnEnabled = value;
  cdnLoaded = true;
  cdnListeners.forEach((listener) => listener(value));
}

function ensureCdnSetting() {
  if (cdnLoaded || cdnInflight) return cdnInflight;
  cdnInflight = fetch("/api/settings")
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (typeof data?.settings?.stockIconCdn === "boolean") publishCdn(data.settings.stockIconCdn);
    })
    .catch(() => {})
    .finally(() => {
      cdnInflight = null;
    });
  return cdnInflight;
}

if (typeof window !== "undefined") {
  window.addEventListener("fire:assets-updated", () => {
    void refreshTypes([...subscribedTypes].filter(type => type !== 'stock' || fullStockCatalog), true);
    void ensureStockIcons([...subscribedStockPairs.values()], true);
    void ensureFlagIcons([...subscribedFlagCodes], true);
  });
  window.addEventListener("fire:settings-updated", () => {
    if (cdnRequested) {
      cdnLoaded = false;
      void ensureCdnSetting();
    }
  });
}

export function useAssetIcons(types?: readonly AssetType[], options: HookOptions = {}) {
  const typeKey = normalizeTypes(types).join(",");
  const requestedTypes = useMemo(() => typeKey.split(",").filter(Boolean) as AssetType[], [typeKey]);
  const [assets, setAssets] = useState<Asset[]>(() => assetsFor(requestedTypes));
  const [cdn, setCdn] = useState(options.stockIconCdn ?? cdnEnabled);
  const [dark, setDark] = useState(() => typeof document !== "undefined" && document.documentElement.classList.contains("dark"));

  useEffect(() => {
    const element = document.documentElement;
    const sync = () => setDark(element.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(element, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof options.stockIconCdn === "boolean") publishCdn(options.stockIconCdn);
    if (options.loadCdnSetting) {
      cdnRequested = true;
      void ensureCdnSetting();
    }
    const onCdn = (value: boolean) => setCdn(value);
    cdnListeners.add(onCdn);
    return () => {
      cdnListeners.delete(onCdn);
    };
  }, [options.loadCdnSetting, options.stockIconCdn]);

  // 首帧就用本地缓存补齐：useLayoutEffect 在浏览器绘制前执行，避免「先画首字母、再切图标」的刷新闪现。
  // 服务端渲染阶段没有 localStorage，这一步不生效；那条路径依赖服务端注入的图标表（见 RecordsApp）。
  useLayoutEffect(() => {
    requestedTypes.forEach((type) => {
      subscribedTypes.add(type);
      if (cache.has(type)) return;
      const saved = loadLocalType(type);
      if (saved) cache.set(type, saved);
    });
    setAssets(assetsFor(requestedTypes));
  }, [requestedTypes, typeKey]);

  useEffect(() => {
    let cancelled = false;
    if (options.fullCatalog) fullStockCatalog = true;
    requestedTypes.forEach((type) => subscribedTypes.add(type));
    setAssets(assetsFor(requestedTypes));

    void refreshTypes(requestedTypes).then(() => {
      if (!cancelled) setAssets(assetsFor(requestedTypes));
    });
    const onUpdate = () => setAssets(assetsFor(requestedTypes));
    listeners.add(onUpdate);
    return () => {
      cancelled = true;
      listeners.delete(onUpdate);
    };
  }, [options.fullCatalog, requestedTypes, typeKey]);

  const marketIcons = useMemo(() => {
    const map: Record<string, string> = {};
    assets.forEach((asset) => {
      if (asset.type === "market") map[asset.market.toUpperCase()] = asset.imageUrl || asset.url;
    });
    return map;
  }, [assets]);

  const countryFlags = useMemo(() => {
    const map: Record<string, string> = {};
    assets.forEach((asset) => {
      if (asset.type === "flag") map[asset.code.toUpperCase()] = asset.imageUrl || asset.url;
    });
    return map;
  }, [assets]);

  const stockIcons = useMemo(() => {
    const map: Record<string, string> = {};
    assets.forEach((asset) => {
      if (asset.type !== "stock") return;
      const market = asset.market.toUpperCase();
      const url = asset.imageUrl || asset.url;
      stockIconLookupCodes(market, asset.code).forEach((item) => {
        const key = `${market}:${item}`;
        if (!map[key]) map[key] = url;
      });
    });
    return applyRelatedEtfMainStockIcons(map);
  }, [assets]);

  const assetIcons = useMemo(() => {
    const map: Record<string, string> = {};
    assets.forEach((asset) => {
      if (asset.type === "crypto" || asset.type === "metal") {
        map[asset.code.toUpperCase()] = dark ? asset.imageUrlDark || asset.urlDark || asset.imageUrl || asset.url : asset.imageUrl || asset.url;
      }
    });
    return map;
  }, [assets, dark]);

  const brokerIcons = useMemo(() => {
    const map: Record<string, string> = {};
    assets.forEach((asset) => {
      if (asset.type === "broker" && asset.name) map[asset.name] = asset.imageUrl || asset.url;
    });
    return map;
  }, [assets]);

  return { assets, marketIcons, countryFlags, stockIcons, assetIcons, brokerIcons, cdnEnabled: cdn };
}
