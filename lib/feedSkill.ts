import fs from "node:fs";
import path from "node:path";
import { FeedError } from "./feedStore";

/** Versioned, read-only runtime skill; shipped in the same lib directory as the application. */
export function feedSkill(mode: "Plan" | "Search" | "Edit" | "Review"): string {
  const file = path.join(process.cwd(), "lib/skills/alcor-feed-editor/SKILL.md");
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { throw new FeedError("动态编辑规则未就绪，请联系站点管理员", 503); }
  const sections = new Map<string, string>();
  for (const part of text.split(/^## /m).slice(1)) {
    const newline = part.indexOf("\n");
    if (newline >= 0) sections.set(part.slice(0, newline).trim(), part.slice(newline).trim());
  }
  if (!sections.get("Shared") || !sections.get(mode)) throw new FeedError("动态编辑规则无效", 503);
  return [sections.get("Shared"), sections.get(mode)].join("\n\n");
}

export type FeedEventHint = { symbol: string; name: string; scheduledDate: string; timing: string };
/** Public cached calendars are hints only, not evidence. No business data or arbitrary URL is read. */
export function feedEventHints(instructions: string, now = new Date()): FeedEventHint[] {
  if (!/(美股|纳斯达克|标普|Wall Street|Nasdaq|S&P|US stocks|U\.S\. stocks)/i.test(instructions)) return [];
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(p => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const end = Date.parse(today + "T12:00:00Z"), start = end - 3 * 86400_000;
  const months = [...new Set([new Date(start).toISOString().slice(0, 7), today.slice(0, 7)])];
  const rows: Array<FeedEventHint & { cap: number }> = [];
  for (const month of months) {
    try {
      const file = path.join(process.cwd(), "data/earnings-cache", `US:${month}.json`);
      if (fs.statSync(file).size > 2_000_000) continue;
      const cache = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isFinite(cache.at) || now.getTime() - cache.at > 7 * 86400_000 || cache.at > now.getTime() + 60_000 || !Array.isArray(cache.items)) continue;
      for (const r of cache.items.slice(0, 1000)) {
        if (!r || typeof r.symbol !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(r.symbol) || typeof r.name !== "string" || r.name.length > 100 || !Number.isFinite(r.marketCap) || r.marketCap < 20_000_000_000 || typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
        const time = Date.parse(r.date + "T12:00:00Z");
        if (time >= start && time <= end) rows.push({ symbol: r.symbol, name: r.name, scheduledDate: r.date, timing: typeof r.time === "string" ? r.time.slice(0, 30) : "unknown", cap: r.marketCap });
      }
    } catch { /* Missing/stale calendar does not block independent market-wide retrieval. */ }
  }
  const seen = new Set<string>();
  return rows.sort((a, b) => b.cap - a.cap).filter(r => !seen.has(r.symbol) && !!seen.add(r.symbol)).slice(0, 8).map(({ cap: _cap, ...hint }) => hint);
}
