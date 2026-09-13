"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { applyRelatedEtfMainStockIcons, pickStockIcon, stockIconLookupCodes } from "@/lib/stockIconKey";

export interface Asset {
  id: string;
  type: "stock" | "market" | "flag" | "broker" | "crypto" | "metal" | "icon";
  market: string;
  code: string;
  name: string;
  url: string;
  urlDark?: string;
  marketCap: number;
  price: number | null;
  changePct: number | null;
  source: "auto" | "manual";
  lastCheckedAt: string;
  board: string;
  updatedAt: string;
}

type AssetType = Asset["type"];
type HookOptions = {
  /** 服务端已经读取设置时直接注入，避免再次请求 /api/settings。 */
  stockIconCdn?: boolean;
  /** 仅确实需要 CDN 开关的组件才读取设置。 */
  loadCdnSetting?: boolean;
  /** 素材库等需要完整 3000+ 股票图标时才拉全量；持仓/首页只用预热或本地缓存。 */
  fullCatalog?: boolean;
};

const ALL_TYPES: AssetType[] = ["stock", "market", "flag", "broker", "crypto", "metal", "icon"];
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_VERSION = 2;
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

function stockMapFromCache(): Record<string, string> {
  const map: Record<string, string> = {};
  (cache.get("stock")?.assets ?? []).forEach((asset) => {
    map[`${asset.market.toUpperCase()}:${asset.code.toUpperCase()}`] = asset.url;
  });
  return map;
}

function applyStockIconPayload(data: { assets?: Array<{ type?: string; market?: string; code?: string; url?: string }> } | null) {
  const icons: Record<string, string> = {};
  (Array.isArray(data?.assets) ? data.assets : []).forEach((asset) => {
    if (asset?.type === "stock" && asset.market && asset.code && asset.url) {
      icons[`${asset.market.toUpperCase()}:${asset.code.toUpperCase()}`] = asset.url;
    }
  });
  if (Object.keys(icons).length) {
    primeStockIconCache(icons);
    notify();
  }
}

/** 财报日历等一次补多张素材库图标，不拉 3000+ 全量。 */
export function ensureStockIcons(pairs: Array<{ market: string; code: string }>) {
  const cached = stockMapFromCache();
  const missing = pairs.filter((pair) => pair.market && pair.code && !pickStockIcon(cached, pair.market, pair.code));
  if (!missing.length) return;
  const keys = [...new Set(missing.map((pair) => `${pair.market.toUpperCase()}:${pair.code.toUpperCase()}`))];
  const batchKey = `batch:${keys.slice().sort().join(",")}`;
  const pending = iconInflight.get(batchKey);
  if (pending) return pending;
  const task = fetch(`/api/assets?type=stock&keys=${encodeURIComponent(keys.join(","))}`)
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => applyStockIconPayload(data))
    .catch(() => { /* 保留已有首字母兜底 */ })
    .finally(() => {
      if (iconInflight.get(batchKey) === task) iconInflight.delete(batchKey);
    });
  iconInflight.set(batchKey, task);
  return task;
}

/** 个股详情 / 划过卡片按需补一张素材库图标，不拉 3000+ 全量。 */
export function ensureStockIcon(market: string, code: string) {
  return ensureStockIcons([{ market, code }]);
}

export function primeStockIconCache(icons: Record<string, string>) {
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
    if (byKey.has(key)) return;
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

/** 首帧结束后把固定货币的小图标送入浏览器图片缓存，打开下拉时无需再等网络。 */
export function usePrefetchFlagIcons(icons: Record<string, string>) {
  useEffect(() => {
    const urls = [...new Set(Object.values(icons).filter((url) => Boolean(url) && !url.startsWith("data:")))];
    if (!urls.length) return;
    const prefetch = () => urls.forEach((url) => {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
    });
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      const id = idleWindow.requestIdleCallback(prefetch, { timeout: 1500 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const id = setTimeout(prefetch, 200);
    return () => clearTimeout(id);
  }, [icons]);
}

const flagInflight = new Map<string, Promise<void>>();
const subscribedFlagCodes = new Set<string>();

/** 货币/地区组件按实际代码取素材库国旗，不再拉取全部 250 个条目。 */
export function ensureFlagIcons(codes: readonly string[], force = false) {
  const normalized = [...new Set(codes.map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)))];
  const existing = new Set((cache.get("flag")?.assets ?? []).map((asset) => asset.code.toUpperCase()));
  const missing = force ? normalized : normalized.filter((code) => !existing.has(code));
  if (!missing.length) return;
  const key = `${force ? "force:" : ""}${missing.slice().sort().join(",")}`;
  const pending = flagInflight.get(key);
  if (pending) return pending;
  const task = fetch(`/api/assets?type=flag&keys=${encodeURIComponent(missing.join(","))}`, force ? { cache: "no-store" } : undefined)
    .then((response) => response.ok ? response.json() : null)
    .then((data) => {
      const icons: Record<string, string> = {};
      (Array.isArray(data?.assets) ? data.assets : []).forEach((asset: Asset) => {
        if (asset.type === "flag" && asset.code && asset.url) icons[asset.code.toUpperCase()] = asset.url;
      });
      if (Object.keys(icons).length) {
        primeFlagIconCache(icons);
        notify();
      }
    })
    .catch(() => { /* 保留素材库内置路径兜底 */ })
    .finally(() => flagInflight.delete(key));
  flagInflight.set(key, task);
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
    const assets = list.filter((asset) => asset.type === type).map((asset) => {
      // FIRE 已恢复为系统默认火焰图标，归一化浏览器里旧的 fire-gray 缓存。
      // 这样不必等待 5 分钟的缓存 TTL 到期，本地版与线上首屏即一致。
      if (type === "icon" && asset.code.toUpperCase() === "FIRE") {
        return { ...asset, url: "/uploads/asset/icon/fire.svg", urlDark: "/uploads/asset/icon/fire-dark.svg" };
      }
      return asset;
    });
    return {
      assets,
      at: Array.isArray(parsed) || parsed.version !== CACHE_VERSION ? 0 : Number(parsed.at) || 0
    };
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
    void refreshTypes([...subscribedTypes], true);
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

    void refreshTypes(requestedTypes, Boolean(options.fullCatalog)).then(() => {
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
      if (asset.type === "market") map[asset.market.toUpperCase()] = asset.url;
    });
    return map;
  }, [assets]);

  const countryFlags = useMemo(() => {
    const map: Record<string, string> = {};
    assets.forEach((asset) => {
      if (asset.type === "flag") map[asset.code.toUpperCase()] = asset.url;
    });
    return map;
  }, [assets]);

  const stockIcons = useMemo(() => {
    const map: Record<string, string> = {};
    assets.forEach((asset) => {
      if (asset.type !== "stock") return;
      const market = asset.market.toUpperCase();
      const url = asset.url;
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
      if (asset.type === "crypto" || asset.type === "metal" || asset.type === "icon") {
        map[asset.code.toUpperCase()] = dark ? asset.urlDark || asset.url : asset.url;
      }
    });
    return map;
  }, [assets, dark]);

  const brokerIcons = useMemo(() => {
    const map: Record<string, string> = {};
    assets.forEach((asset) => {
      if (asset.type === "broker" && asset.name) map[asset.name] = asset.url;
    });
    return map;
  }, [assets]);

  return { assets, marketIcons, countryFlags, stockIcons, assetIcons, brokerIcons, cdnEnabled: cdn };
}
