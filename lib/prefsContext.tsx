"use client";

import { createContext, useContext, type ReactNode } from "react";
import { prefsCookieString, readPrefsCookie, type PrefMap } from "./prefsCookie";

const ServerPrefsContext = createContext<PrefMap>({});

/**
 * 布局（服务端组件）读 `fire_prefs` cookie 后把整张偏好表传进来。
 * usePersistedState 用它当**首帧**的值（服务端渲染与客户端首帧一致），
 * 于是「原文 / 简体 / 繁體 / 英文」这类偏好刷新后不会再先闪默认值。
 */
export function PrefsProvider({ initialPrefs, children }: { initialPrefs: PrefMap; children: ReactNode }) {
  return <ServerPrefsContext.Provider value={initialPrefs}>{children}</ServerPrefsContext.Provider>;
}

export function useServerPrefs(): PrefMap {
  return useContext(ServerPrefsContext);
}

/** 把一条偏好合并写回 cookie（客户端）：下次刷新服务端就能直接读到 */
export function writePrefCookie(key: string, value: unknown) {
  if (typeof document === "undefined") return;
  try {
    const next: PrefMap = { ...readPrefsCookie(), [key]: value };
    document.cookie = prefsCookieString(next);
  } catch {
    /* 隐私模式 / cookie 被禁用：localStorage 仍然生效，下次刷新会闪一下而已 */
  }
}
