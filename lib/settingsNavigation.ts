type SettingItem = { sub: string; anchor: string };
type SettingCategory = { key: string; anchors: readonly string[] };

/** URL is the only source of view state, including same-subsection back/forward. */
export function resolveSettingsLocation(params: URLSearchParams, items: readonly SettingItem[], categories: readonly SettingCategory[]) {
  const requestedSub = params.get("sub");
  const requestedAnchor = params.get("anchor");
  if (!requestedSub) {
    const requestedCategory = params.get("category");
    const category = categories.find((entry) => entry.key === requestedCategory && entry.anchors.some((anchor) => items.some((item) => item.anchor === anchor)));
    return { category: category?.key || "home", item: null };
  }
  const sub = requestedSub === "profile" && requestedAnchor === "totp" ? "totp" : requestedSub;
  const item = items.find((entry) => entry.sub === sub && entry.anchor === requestedAnchor)
    || items.find((entry) => entry.sub === sub)
    || items.find((entry) => entry.anchor === "profile")
    || items[0];
  return { category: item ? null : "home", item: item || null };
}
