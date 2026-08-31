"use client";

import { useCallback, useEffect, useState } from "react";

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
 */
export function usePersistedState<T>(key: string, initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readPersisted(key, initial));
  const setPersistedValue = useCallback<React.Dispatch<React.SetStateAction<T>>>((next) => {
    setValue((current) => {
      const resolved = typeof next === "function" ? (next as (previous: T) => T)(current) : next;
      try {
        localStorage.setItem(key, JSON.stringify(resolved));
        queueMicrotask(() => window.dispatchEvent(new CustomEvent(PERSISTED_STATE_EVENT, { detail: { key, value: resolved } })));
      } catch {
        /* 存储失败仍更新当前组件 */
      }
      return resolved;
    });
  }, [key]);
  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; value?: T }>).detail;
      if (detail?.key === key) setValue(detail.value as T);
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === key) setValue(readPersisted(key, initial));
    };
    window.addEventListener(PERSISTED_STATE_EVENT, sync);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(PERSISTED_STATE_EVENT, sync);
      window.removeEventListener("storage", syncStorage);
    };
  }, [initial, key]);
  return [value, setPersistedValue];
}
