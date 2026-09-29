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

// 与 desktop.css 的隐藏条件一致；CSS 隐藏不能阻止图片请求。
export const FOUR_DOOR_QUERY = "(min-width: 1280px) and (min-height: 801px) and (any-pointer: fine) and (not (any-pointer: coarse))";
function subscribeFourDoor(onChange: () => void) {
  const media = window.matchMedia(FOUR_DOOR_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
export function useFourDoorViewport() {
  return useSyncExternalStore(subscribeFourDoor, () => window.matchMedia(FOUR_DOOR_QUERY).matches, serverSnapshot);
}
