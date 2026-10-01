const VERSION_TONES = ["violet", "cyan", "amber", "rose", "blue"] as const;

export function apiVersionFromPath(path: string): number | null {
  const match = /^\/api\/v([1-9]\d*)(?:\/|$)/.exec(path);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : null;
}

export function apiVersionTone(version: number) {
  return version === 1 ? "neutral" : VERSION_TONES[(version - 2) % VERSION_TONES.length] ?? "neutral";
}
