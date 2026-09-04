import fs from "node:fs";
import path from "node:path";

const defaultsDir = process.env.FIRE_TRADING_DEFAULTS_DIR || "/app/trading-square-default";
const dataDir = process.env.FIRE_TRADING_DATA_DIR || "/app/data";

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeAtomic(file, value) {
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
}
