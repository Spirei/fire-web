/** Shared identity rules for file import, OCR preview and persisted records. */
const ALIASES: Record<string, string> = {
  US: "US", USA: "US", NASDAQ: "US", NYSE: "US", AMEX: "US", OTC: "US", 美股: "US",
  HK: "HK", HONGKONG: "HK", 港股: "HK", CN: "CN", A: "CN", SH: "CN", SZ: "CN", BJ: "CN", SSE: "CN", SZSE: "CN", A股: "CN", 沪: "CN", 深: "CN",
  SG: "SG", SGX: "SG", SINGAPORE: "SG", 新加坡: "SG", JP: "JP", JAPAN: "JP", T: "JP", TYO: "JP", 日股: "JP",
  KR: "KR", KOREA: "KR", KS: "KR", KQ: "KR", KOSPI: "KR", 韩股: "KR", UK: "UK", L: "UK", LSE: "UK"
};
export function normalizeImportMarket(raw = ""): string {
  const value = raw.trim().toUpperCase();
  return ALIASES[value] || (/^(DE|FR|AU|CA|IN|TW|BR|ASSET|OTHER)$/.test(value) ? value : "");
}
export function importIdentity(raw: string, marketHint = "") {
  let code = String(raw || "").trim().toUpperCase();
  let market = normalizeImportMarket(marketHint);
  const prefix = code.match(/^(US|HK|CN|SH|SZ|BJ|SG|JP|KR|UK)[.:]([A-Z0-9._-]+)$/)
    || code.match(/^(HK)(\d{1,5})$/)
    || code.match(/^(SH|SZ|BJ)(\d{6})$/);
  const suffix = code.match(/^(.+)\.(US|HK|CN|SG|JP|KR|UK)$/);
  const explicit = prefix ? normalizeImportMarket(prefix[1]) : suffix ? normalizeImportMarket(suffix[2]) : "";
  if (market && explicit && market !== explicit) throw new Error(`股票 ${raw} 的市场与代码前缀不一致`);
  if (prefix) code = prefix[2];
  else if (suffix) code = suffix[1];
  market ||= explicit;
  if (!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(code)) return { code: "", market };
  if (market === "HK" && /^\d{1,5}$/.test(code)) code = code.padStart(5, "0");
  if (market === "JP") code = code.replace(/\.T$/, "");
  if (market === "KR") code = code.replace(/\.(KS|KQ)$/, "");
  return { code, market };
}
export function importCodeKey(market: string, raw: string) {
  const identity = importIdentity(raw, market);
  return `${identity.market}:${identity.code}`;
}
