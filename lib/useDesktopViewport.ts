"use client";

import { useSyncExternalStore } from "react";
import { isTabletDevice } from "@/lib/deviceIdentity";

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

const tabletSnapshot = () => isTabletDevice(navigator);
const subscribeIdentity = () => () => {};

/** Device identity is separate from the viewport; SSR and hydration both start false. */
export function useTabletDevice() {
  return useSyncExternalStore(subscribeIdentity, tabletSnapshot, serverSnapshot);
}

// Only the primary input matters. A secondary touchscreen must not hide desktop UI.
// Tablet identity is checked before mounting, even when an iPad has a mouse attached.
export const FOUR_DOOR_QUERY = "(min-width: 1280px) and (min-height: 801px) and (hover: hover) and (pointer: fine)";
function subscribeFourDoor(onChange: () => void) {
  const media = window.matchMedia(FOUR_DOOR_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
export function useFourDoorViewport() {
  return useSyncExternalStore(subscribeFourDoor, () => !tabletSnapshot() && window.matchMedia(FOUR_DOOR_QUERY).matches, serverSnapshot);
}
