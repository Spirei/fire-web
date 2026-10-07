export const ALLOCATION_CATEGORIES = ["securities", "cash", "investment", "fixed", "receivable", "debt"] as const;
export type AllocationCategory = typeof ALLOCATION_CATEGORIES[number];
export const ALLOCATION_LABELS: Record<AllocationCategory, string> = { securities: "证券持仓", cash: "现金", investment: "其他投资", fixed: "固定资产", receivable: "应收款", debt: "负债" };
export interface AllocationAccount {
  id: string; name: string; kind: "broker" | "bank" | "fund" | "ledger" | "manual";
  category: AllocationCategory; currency: string; amount: number | null; value: number | null;
  holdings: number | null; cash: number | null; recordIds: string[]; icon: string;
  source: string; updatedAt: string | null; excluded: boolean; reconciled: boolean; revision: number;
  components: Partial<Record<AllocationCategory, number | null>>;
}
export interface AllocationSnapshot {
  version: 1; accountId: string; currency: string; observedAt: string;
  summary: { totalAsset: number | null; totalDebt: number | null; netAsset: number | null; knownAsset: number; complete: boolean; accountCount: number; portfolioTotalAsset: number | null; difference: number | null };
  accounts: AllocationAccount[];
  bankSummary: { count: number; includedCount: number; value: number | null };
  brokers: { id: string; name: string; icon: string }[];
  positions: { id: string; name: string; code: string; currency: string; brokerId: string | null; revision: number; accountId: string }[];
  categories: { id: AllocationCategory; name: string; value: number | null; weightPct: number | null }[];
  issues: { code: string; accountIds: string[]; message: string }[];
  quoteStatus: { pending: boolean; cached: string[]; missing: string[] };
}
export interface AllocationInput { id?: string; requestId?: string; revision: number; name: string; currency: string; amount: number; category: AllocationCategory; excluded: boolean; }
