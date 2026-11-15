/** Broker names in settings and records differ by 证劵/证券, case and an
 * optional 账户 suffix. Icon lookup must not depend on that exact spelling. */
export function brokerIconKey(value?: string | null) {
  if (!value) return "";
  return value
    .normalize("NFKC")
    .replace(/[\s_\-·]+/g, "")
    .replace(/[证證][券劵]/g, "证券")
    .replace(/(?:账户|帐号|账号)$/g, "")
    .toLowerCase();
}

/** Resolve a broker icon by its stored name, then by the normalized name. */
export function brokerIconUrl(map: Record<string, string> | undefined, name?: string | null) {
  if (!map || !name) return "";
  const direct = map[name];
  if (direct) return direct;
  const key = brokerIconKey(name);
  return key ? map[key] || "" : "";
}
