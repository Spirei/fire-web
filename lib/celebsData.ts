// 浏览器契约类型；业务由 Fire 内置后端统一执行。
import type {Celeb,CelebDataSource,CelebHolding} from "./celebs";
interface FetchedCeleb {
  holdings: CelebHolding[];
  updated: string;
  reportQuarter?: string;
  source: CelebDataSource;
  accession?: string;
}
interface CacheShape {
  schema?: number;
  at: number;
  ttl: number;
  celebs: Celeb[];
  detail: Record<string, string>;
  /** 每位名人的最近一次成功拉取时间（ISO），用于按人增量刷新 */
  fetchedAt: Record<string, string>;
  /** 每位名人的最新 13F 申报号（同一申报号不重复解析） */
  lastAccession: Record<string, string>;
  /** 最近一次定时检查的日期（YYYY-MM-DD） */
  scheduledDate: string;
}
export interface CelebsResult {
  celebs: Celeb[];
  source: "sec-edgar" | "cache" | "sample" | "stored_public_disclosures";
  updatedAt: string;
  detail: Record<string, unknown>;
  stockIcons?: Record<string, string>;
}
export interface ReturnsDaily {
  dates: string[];
  values: number[];
  benchmarks: { code: string; name: string; values: number[] }[];
}
