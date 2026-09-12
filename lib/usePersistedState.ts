"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerPrefs, writePrefCookie } from "./prefsContext";

const PERSISTED_STATE_EVENT = "fire:persisted-state";

function readPersisted<T>(key: string, fallback: T | (() => T)): T {
  const initial = () => typeof fallback === "function" ? (fallback as () => T)() : fallback;
  if (typeof window === "undefined") return initial();
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return initial();
    try { return JSON.parse(raw) as T; } catch { return raw as T; }
  } catch {
    return initial();
  }
}

/**
 * 本地持久化 state：刷新 / 重进页面保持用户偏好（localStorage）。
 * 用法与 useState 一致：const [v, setV] = usePersistedState("fire:xxx", 默认值)
 *
 * 首帧值优先用服务端从 `fire_prefs` cookie 注入的那份（见 lib/prefsCookie.ts）：
 * 这样刷新时服务端与客户端首帧都是用户的选择，不会先闪默认值再跳回去。
 * 每次改动同时写 localStorage 与 cookie —— cookie 那份是给服务端首帧读的。
 */
export function usePersistedState<T>(key: string, initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
  const initialRef = useRef(initial);
  const serverPrefs = useServerPrefs();
  const hasServerPref = Object.prototype.hasOwnProperty.call(serverPrefs, key);
  // SSR 与客户端首帧必须取同一个值：有 cookie（服务端注入）就用它，没有才退回默认值。
  const [value, setValue] = useState<T>(() =>
    hasServerPref ? (serverPrefs[key] as T) : typeof initial === "function" ? (initial as () => T)() : initial
  );
  const setPersistedValue = useCallback<React.Dispatch<React.SetStateAction<T>>>((next) => {
    setValue((current) => {
      const resolved = typeof next === "function" ? (next as (previous: T) => T)(current) : next;
      try {
        localStorage.setItem(key, JSON.stringify(resolved));
        writePrefCookie(key, resolved);
        queueMicrotask(() => window.dispatchEvent(new CustomEvent(PERSISTED_STATE_EVENT, { detail: { key, value: resolved } })));
      } catch {
        /* 存储失败仍更新当前组件 */
      }
      return resolved;
    });
  }, [key]);
  useEffect(() => {
    let hasLocal = true;
    try {
      hasLocal = localStorage.getItem(key) !== null;
    } catch {
      hasLocal = false;
    }
    if (!hasLocal && hasServerPref) {
      // cookie 里有、localStorage 里没有（清过缓存 / 换了浏览器配置）：把 cookie 那份补回 localStorage，保持两边一致
      try {
        localStorage.setItem(key, JSON.stringify(serverPrefs[key]));
      } catch {
        /* 忽略 */
      }
    } else {
      const stored = readPersisted(key, initialRef.current);
      setValue(stored);
      // 两处不一致就回写 cookie：① 老用户只有 localStorage（这次仍会闪，之后不再闪）；
      // ② cookie 里是旧值（用户清了某一侧 / 手动改过 localStorage）—— 以 localStorage 为准，自愈。
      if (!hasServerPref || JSON.stringify(stored) !== JSON.stringify(serverPrefs[key])) writePrefCookie(key, stored);
    }
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; value?: T }>).detail;
      if (detail?.key === key) setValue(detail.value as T);
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === key) setValue(readPersisted(key, initialRef.current));
    };
    window.addEventListener(PERSISTED_STATE_EVENT, sync);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(PERSISTED_STATE_EVENT, sync);
      window.removeEventListener("storage", syncStorage);
    };
  }, [key]);
  return [value, setPersistedValue];
}
