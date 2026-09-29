export type DeviceIdentity = Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">;

/** Touch support is not a device category: Windows laptops stay desktop. */
export function isTabletDevice({ userAgent, platform, maxTouchPoints }: DeviceIdentity): boolean {
  if (/Windows|Win32|Win64|CrOS/i.test(`${userAgent} ${platform}`)) return false;
  if (/iPhone|iPod/i.test(userAgent)) return false;
  if (/iPad|Tablet/i.test(userAgent)) return true;
  if (/Android/i.test(userAgent)) return !/Mobile/i.test(userAgent);
  // iPadOS desktop-site mode uses a Mac identity, including with a trackpad.
  return /Mac/i.test(platform) && maxTouchPoints > 1;
}
