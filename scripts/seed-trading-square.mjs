import fs from "node:fs";
import path from "node:path";

const defaultsDir = process.env.FIRE_PUBLIC_CACHE_DEFAULTS_DIR || process.env.FIRE_TRADING_DEFAULTS_DIR || "/app/public-cache-default";
const dataDir = process.env.FIRE_TRADING_DATA_DIR || "/app/data";

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

if (fs.existsSync(defaultsDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const name of ["duan-posts.json", "trump-posts.json"]) {
    const bundled = readJson(path.join(defaultsDir, name), []);
    if (!Array.isArray(bundled) || bundled.length === 0) continue;
    const target = path.join(dataDir, name);
    const runtime = readJson(target, []);
    const merged = new Map(bundled.map((post) => [String(post.id), post]));
    if (Array.isArray(runtime)) {
      for (const post of runtime) merged.set(String(post.id), post);
    }
    const posts = [...merged.values()].sort((a, b) => Date.parse(b.date || "") - Date.parse(a.date || ""));
    writeAtomic(target, posts);
  }

  const translationsName = "trump-translations.json";
  const bundledTranslations = readJson(path.join(defaultsDir, translationsName), {});
  const translationsTarget = path.join(dataDir, translationsName);
  const runtimeTranslations = readJson(translationsTarget, {});
  writeAtomic(translationsTarget, { ...bundledTranslations, ...runtimeTranslations });

  const rankingsName = "top-stocks-cache.json";
  const bundledRankings = readJson(path.join(defaultsDir, rankingsName), {});
  const rankingsTarget = path.join(dataDir, rankingsName);
  const runtimeRankings = readJson(rankingsTarget, {});
  const rankings = { ...bundledRankings };
  for (const [market, value] of Object.entries(runtimeRankings)) {
    const bundledAt = Number(rankings[market]?.at || 0);
    if (Number(value?.at || 0) >= bundledAt) rankings[market] = value;
  }
  if (Object.keys(rankings).length > 0) writeAtomic(rankingsTarget, rankings);

  // 加密货币与贵金属分别维护独立时间戳，避免其中一类较新的运行缓存被整体回滚。
  const quotesName = "asset-quotes-cache.json";
  const bundledQuotes = readJson(path.join(defaultsDir, quotesName), {});
  const quotesTarget = path.join(dataDir, quotesName);
  const runtimeQuotes = readJson(quotesTarget, {});
  const quotes = { ...bundledQuotes };
  for (const kind of ["crypto", "metal"]) {
    const atKey = `${kind}At`;
    if (Number(runtimeQuotes[atKey] || 0) >= Number(bundledQuotes[atKey] || 0)) {
      quotes[kind] = runtimeQuotes[kind] ?? quotes[kind];
      quotes[atKey] = runtimeQuotes[atKey] ?? quotes[atKey];
    }
  }
  if (Object.keys(quotes).length > 0) writeAtomic(quotesTarget, quotes);

  // 名人持仓是一份整体快照，以快照更新时间选择较新版本。
  const celebsName = "celebs-cache.json";
  const bundledCelebs = readJson(path.join(defaultsDir, celebsName), null);
  const celebsTarget = path.join(dataDir, celebsName);
  const runtimeCelebs = readJson(celebsTarget, null);
  const celebs = Number(runtimeCelebs?.at || 0) >= Number(bundledCelebs?.at || 0) ? runtimeCelebs : bundledCelebs;
  if (celebs && Array.isArray(celebs.celebs)) writeAtomic(celebsTarget, celebs);

  // 财报缓存按市场和月份逐文件选择较新版本，保留线上已刷新的月份。
  const bundledEarningsDir = path.join(defaultsDir, "earnings-cache");
  if (fs.existsSync(bundledEarningsDir)) {
    for (const name of fs.readdirSync(bundledEarningsDir).filter((item) => item.endsWith(".json"))) {
      const bundled = readJson(path.join(bundledEarningsDir, name), null);
      if (!bundled || !Array.isArray(bundled.items)) continue;
      const target = path.join(dataDir, "earnings-cache", name);
      const runtime = readJson(target, null);
      const selected = Number(runtime?.at || 0) >= Number(bundled.at || 0) ? runtime : bundled;
      writeAtomic(target, selected);
    }
  }
}
