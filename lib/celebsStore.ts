/* ---------- 名人持仓 · 数据库存储 ----------
 *
 * 名人与持仓改为数据库维护（SQLite celebs 表），后台可增删改：
 *  - 基本信息：名称 / 头衔 / 头像 / 启停 / 排序
 *  - 数据来源：13F（机构季报）/ Form 4（董监高变动）/ 示例数据（手动维护）
 *  - 内容：持仓明细 / 近期操作 / 收益曲线（JSON 列）
 * SEC EDGAR 真实数据管道按每条记录的来源配置工作，手动数据作为兜底。
 */

import { getDb } from "./db";
import { CELEBS, type CelebHolding, type CelebTrade } from "./celebs";

export type CelebSourceKind = "13f" | "form4" | "none";

export interface CelebRow {
  id: string;
  name: string;
  title: string;
  avatar: string;
  enabled: boolean;
  sort: number;
  sourceKind: CelebSourceKind;
  cik: string;
  entity: string;
  sourceLabel: string;
  holdings: CelebHolding[];
  trades: CelebTrade[];
  returns: {
    y1: number;
    y3: number;
    y5: number;
    spxY1: number;
    points: number[];
    spxPoints: number[];
    benchmarks?: { code: string; name: string; y1: number; points: number[] }[];
  };
  stockIcons: Record<string, string>; // 名人专属股票图标（只在本名人生效）
  refreshHours: number; // 数据有效期（小时），0 = 按来源类型自动
  createdAt: string;
  updatedAt: string;
}

export interface CelebInput {
  id: string;
  name?: string;
  title?: string;
  avatar?: string;
  enabled?: boolean;
  sort?: number;
  sourceKind?: CelebSourceKind;
  cik?: string;
  entity?: string;
  sourceLabel?: string;
  holdings?: CelebHolding[];
  trades?: CelebTrade[];
  returns?: CelebRow["returns"];
  stockIcons?: Record<string, string>;
  refreshHours?: number;
}

/* 已知名人的 SEC 来源配置（种子数据用；后台可改） */
const SEED_SOURCES: Record<string, { kind: CelebSourceKind; cik: string; entity: string; label: string }> = {
  buffett: { kind: "13f", cik: "0001067983", entity: "Berkshire Hathaway", label: "SEC EDGAR 13F · 伯克希尔" },
  pelosi: { kind: "none", cik: "", entity: "", label: "公开披露 · 示例数据" },
  huang: { kind: "13f", cik: "0001045810", entity: "NVIDIA Corporation", label: "SEC EDGAR 13F · 英伟达" },
  cathie: { kind: "13f", cik: "0001697748", entity: "ARK Investment Management", label: "SEC EDGAR 13F · 方舟投资" },
  trump: { kind: "none", cik: "", entity: "", label: "公开披露 · 示例数据" },
  duan: { kind: "13f", cik: "0001759760", entity: "H&H International Investment", label: "SEC EDGAR 13F · H&H 国际投资" }
};

interface Row {
  id: string;
  name: string;
  title: string;
  avatar: string;
  enabled: number;
  sort: number;
  source_kind: string;
  cik: string;
  entity: string;
  source_label: string;
  holdings_json: string;
  trades_json: string;
  returns_json: string;
  stock_icons_json: string;
  refresh_hours: number;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToCeleb(row: Row): CelebRow {
  const returns = parseJson(row.returns_json, {
    y1: 0,
    y3: 0,
    y5: 0,
    spxY1: 0,
    points: [0],
    spxPoints: [0],
    benchmarks: []
  });
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    avatar: row.avatar,
    enabled: row.enabled === 1,
    sort: row.sort,
    sourceKind: (row.source_kind as CelebSourceKind) || "none",
    cik: row.cik,
    entity: row.entity,
    sourceLabel: row.source_label,
    holdings: parseJson<CelebHolding[]>(row.holdings_json, []),
    trades: parseJson<CelebTrade[]>(row.trades_json, []),
    returns,
    stockIcons: parseJson<Record<string, string>>(row.stock_icons_json, {}),
    refreshHours: row.refresh_hours || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listCelebRows(enabledOnly = false): CelebRow[] {
  const db = getDb();
  const rows = (enabledOnly
    ? db.prepare("SELECT * FROM celebs WHERE enabled = 1 ORDER BY sort ASC, created_at ASC").all()
    : db.prepare("SELECT * FROM celebs ORDER BY sort ASC, created_at ASC").all()) as Row[];
  return rows.map(rowToCeleb);
}

export function getCelebRow(id: string): CelebRow | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM celebs WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToCeleb(row) : null;
}

export function createCeleb(input: CelebInput): CelebRow {
  const db = getDb();
  const now = new Date().toISOString();
  const maxSort = (db.prepare("SELECT COALESCE(MAX(sort), -1) AS m FROM celebs").get() as { m: number }).m;
  const row: Row = {
    id: input.id,
    name: input.name ?? "",
    title: input.title ?? "",
    avatar: input.avatar ?? "",
    enabled: input.enabled === false ? 0 : 1,
    sort: input.sort ?? maxSort + 1,
    source_kind: input.sourceKind ?? "none",
    cik: input.cik ?? "",
    entity: input.entity ?? "",
    source_label: input.sourceLabel ?? "",
    holdings_json: JSON.stringify(input.holdings ?? []),
    trades_json: JSON.stringify(input.trades ?? []),
    returns_json: JSON.stringify(input.returns ?? { y1: 0, y3: 0, y5: 0, spxY1: 0, points: [0], spxPoints: [0], benchmarks: [] }),
    stock_icons_json: JSON.stringify(input.stockIcons ?? {}),
    refresh_hours: input.refreshHours ?? 0,
    created_at: now,
    updated_at: now
  };
  db.prepare(
    `INSERT INTO celebs (id, name, title, avatar, enabled, sort, source_kind, cik, entity, source_label, holdings_json, trades_json, returns_json, stock_icons_json, refresh_hours, created_at, updated_at)
     VALUES (@id, @name, @title, @avatar, @enabled, @sort, @source_kind, @cik, @entity, @source_label, @holdings_json, @trades_json, @returns_json, @stock_icons_json, @refresh_hours, @created_at, @updated_at)`
  ).run(row as unknown as Record<string, unknown>);
  return getCelebRow(input.id)!;
}

export function updateCeleb(id: string, input: Partial<CelebInput>): CelebRow | null {
  const db = getDb();
  const cur = getCelebRow(id);
  if (!cur) return null;
  // 仅合并显式传入的字段（过滤 undefined），避免部分更新把已有字段清空
  const cleanInput = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<CelebInput>;
  const merged: CelebInput = {
    ...cur,
    ...cleanInput,
    id: cur.id
  };
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE celebs SET name = ?, title = ?, avatar = ?, enabled = ?, sort = ?, source_kind = ?, cik = ?, entity = ?, source_label = ?, holdings_json = ?, trades_json = ?, returns_json = ?, stock_icons_json = ?, refresh_hours = ?, updated_at = ? WHERE id = ?`
  ).run(
    merged.name,
    merged.title ?? "",
    merged.avatar ?? "",
    merged.enabled === false ? 0 : 1,
    merged.sort ?? cur.sort,
    merged.sourceKind ?? cur.sourceKind,
    merged.cik ?? "",
    merged.entity ?? "",
    merged.sourceLabel ?? "",
    JSON.stringify(merged.holdings ?? cur.holdings),
    JSON.stringify(merged.trades ?? cur.trades),
    JSON.stringify(merged.returns ?? cur.returns),
    JSON.stringify(merged.stockIcons ?? cur.stockIcons),
    merged.refreshHours ?? cur.refreshHours ?? 0,
    now,
    id
  );
  return getCelebRow(id);
}

export function deleteCeleb(id: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM celebs WHERE id = ?").run(id);
  return res.changes > 0;
}

export function reorderCelebs(ids: string[]): void {
  const db = getDb();
  const stmt = db.prepare("UPDATE celebs SET sort = ?, updated_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    ids.forEach((id, i) => stmt.run(i, now, id));
  });
  tx();
}

export function seedCelebsIfEmpty(): void {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) AS n FROM celebs").get() as { n: number }).n;
  if (count > 0) return;
  const tx = db.transaction(() => {
    CELEBS.forEach((c, i) => {
      const src = SEED_SOURCES[c.id] ?? { kind: "none" as const, cik: "", entity: "", label: "示例数据" };
      createCeleb({
        id: c.id,
        name: c.name,
        title: c.title,
        avatar: c.avatar,
        enabled: true,
        sort: i,
        sourceKind: src.kind,
        cik: src.cik,
        entity: src.entity,
        sourceLabel: src.label,
        holdings: c.holdings,
        trades: c.trades,
        returns: c.returns
      });
    });
  });
  tx();
}
