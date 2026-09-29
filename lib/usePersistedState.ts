"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerPrefs, writePrefCookie } from "./prefsContext";
import { readPrefsCookie } from "./prefsCookie";
import { showToast } from "./toast";

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
  const valueRef = useRef(value);
  const setPersistedValue = useCallback<React.Dispatch<React.SetStateAction<T>>>((next) => {
    // 写入必须发生在用户操作中；React 的 state updater 可能延后或重放，刷新会抢在写入前。
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(valueRef.current) : next;
    valueRef.current = resolved;
    let localSaved = false;
    try {
      localStorage.setItem(key, JSON.stringify(resolved));
      localSaved = true;
    } catch { /* Safari 存储受限时仍尝试 cookie。 */ }
    const cookieSaved = writePrefCookie(key, resolved);
    if (!localSaved && !cookieSaved) showToast("浏览器未允许保存偏好，请检查隐私设置", "err");
    setValue(resolved);
    queueMicrotask(() => window.dispatchEvent(new CustomEvent(PERSISTED_STATE_EVENT, { detail: { key, value: resolved } })));
  }, [key]);
  useEffect(() => {
    let hasLocal = true;
    try {
      hasLocal = localStorage.getItem(key) !== null;
    } catch {
      hasLocal = false;
    }
    const cookiePrefs = readPrefsCookie();
    const hasCookie = Object.prototype.hasOwnProperty.call(cookiePrefs, key);
    if (!hasLocal && hasCookie) {
      // localStorage 不可用时仍可从本次最新的 cookie 恢复，不依赖服务端首帧快照。
      valueRef.current = cookiePrefs[key] as T;
      setValue(cookiePrefs[key] as T);
      try {
        localStorage.setItem(key, JSON.stringify(cookiePrefs[key]));
      } catch {
        /* 忽略 */
      }
    } else {
      const stored = readPersisted(key, initialRef.current);
      valueRef.current = stored;
      setValue(stored);
      // 两处不一致就回写 cookie：① 老用户只有 localStorage（这次仍会闪，之后不再闪）；
      // ② cookie 里是旧值（用户清了某一侧 / 手动改过 localStorage）—— 以 localStorage 为准，自愈。
      if (!hasServerPref || JSON.stringify(stored) !== JSON.stringify(serverPrefs[key])) writePrefCookie(key, stored);
    }
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; value?: T }>).detail;
      if (detail?.key === key) {
        valueRef.current = detail.value as T;
        setValue(detail.value as T);
      }
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === key) {
        const stored = readPersisted(key, initialRef.current);
        valueRef.current = stored;
        setValue(stored);
      }
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
