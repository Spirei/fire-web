"use client";

import { useEffect, useState } from "react";

/**
 * 本地持久化 state：刷新 / 重进页面保持用户偏好（localStorage）。
 * 用法与 useState 一致：const [v, setV] = usePersistedState("fire:xxx", 默认值)
 */
export function usePersistedState<T>(key: string, initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") {
      return typeof initial === "function" ? (initial as () => T)() : initial;
    }
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      /* 损坏缓存忽略 */
    }
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 存储失败忽略 */
    }
  }, [key, value]);
  return [value, setValue];
}
