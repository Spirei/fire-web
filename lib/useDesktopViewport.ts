"use client";

import { useSyncExternalStore } from "react";

const query = "(min-width: 1024px)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const snapshot = () => window.matchMedia(query).matches;
const serverSnapshot = () => false;

/** 只用于桌面增强组件；服务端与水合首帧一致，不改变当前页面的 SSR。 */
export function useDesktopViewport() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
