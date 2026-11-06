import { isPersonalFontId } from "./personal-font-id.ts";
import { fontOperationId } from "./personal-font-state.ts";
import type { SourceWindow } from "./source-window-view.ts";
type Store = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
const prefix = "alcor.font-catalog-request:",
  hash = /^[a-f0-9]{64}$/;
const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
export type CatalogSource = {
  sourceAlias: string;
  sourceInstance: string;
  window: SourceWindow;
};
export type FontCatalogSummary = {
  id: string;
  requestId: string;
  sourceAlias: string;
  sourceInstance: string;
  sha256: string;
  scanState: "sealed" | "truncated" | "changed";
  truncated: boolean;
  changed: boolean;
  ignored: number;
  visited: number;
  maxEntries: number;
  counts: Record<
    | "knownItems"
    | "sourceBlocked"
    | "unassigned"
    | "pendingConfirmation"
    | "authorizedNotCaptured"
    | "archived"
    | "mapped"
    | "revoked"
    | "ownerClosed"
    | "ownerDisabled"
    | "historyGap",
    number
  >;
  contentVerified: false;
  historicalUploaderVerified: false;
  entireSourceComplete: false;
  instanceReenrollmentRequired: boolean;
};
export type FontCatalogEntry = {
  ordinal: number;
  originalId: string;
  filenameSha256: string;
  size: number | null;
  metadataState: "candidate" | "blocked";
  reason: string | null;
  assignmentState:
    | "unassigned"
    | "pending_owner"
    | "authorized"
    | "archived"
    | "mapped"
    | "revoked"
    | "owner_closed"
    | "owner_disabled"
    | "assignment_retained"
    | "history_gap";
  permissionId: string | null;
  ownerId: string | null;
  contentVerified: false;
  historicalUploaderVerified: false;
};
export type FontCatalogPage = FontCatalogSummary & {
  items: FontCatalogEntry[];
  nextAfter: number | null;
};
export type FontCatalogReceipt = {
  requestId: string;
  kind: "catalog";
  state: "reading" | "completed" | "failed";
  catalogId?: string;
  sha256?: string;
  canceled?: boolean;
  message?: string;
  reason?: string;
  entireSourceComplete: false;
};
export function fontCatalogSummary(raw: unknown) {
  const v = raw as FontCatalogSummary;
  if (
    !v ||
    !fontOperationId(v.id) ||
    v.requestId !== v.id ||
    !hash.test(v.sha256) ||
    typeof v.sourceAlias !== "string" ||
    typeof v.sourceInstance !== "string" ||
    !["sealed", "truncated", "changed"].includes(v.scanState) ||
    ![v.truncated, v.changed, v.instanceReenrollmentRequired].every(
      (n) => typeof n === "boolean",
    ) ||
    ![v.ignored, v.visited, v.maxEntries].every(count) ||
    v.maxEntries < 1 ||
    v.maxEntries > 5000 ||
    v.visited > v.maxEntries ||
    v.contentVerified !== false ||
    v.historicalUploaderVerified !== false ||
    v.entireSourceComplete !== false ||
    !v.counts ||
    ![
      "knownItems",
      "sourceBlocked",
      "unassigned",
      "pendingConfirmation",
      "authorizedNotCaptured",
      "archived",
      "mapped",
      "revoked",
      "ownerClosed",
      "ownerDisabled",
      "historyGap",
    ].every((k) => count(v.counts[k as keyof typeof v.counts])) ||
    Object.values(v.counts).some((n) => n > v.counts.knownItems) ||
    v.counts.mapped > v.counts.archived ||
    v.counts.knownItems + v.ignored !== v.visited ||
    (v.truncated && v.scanState === "sealed") ||
    (v.changed && v.scanState !== "changed")
  )
    throw new Error("字体目录清单待核对");
  return v;
}
export function fontCatalogPage(raw: unknown) {
  const v = fontCatalogSummary(raw) as FontCatalogPage;
  if (
    !Array.isArray(v.items) ||
    v.items.length > 32 ||
    (v.nextAfter !== null && !count(v.nextAfter))
  )
    throw new Error("字体目录分页待核对");
  let before = -1;
  for (const item of v.items) {
    if (
      !count(item.ordinal) ||
      item.ordinal <= before ||
      item.ordinal >= v.counts.knownItems ||
      !isPersonalFontId(item.originalId) ||
      item.originalId.split("-").pop()?.split(".")[0] !== item.filenameSha256 ||
      !hash.test(item.filenameSha256) ||
      (item.size !== null && !count(item.size)) ||
      !["candidate", "blocked"].includes(item.metadataState) ||
      ![
        "unassigned",
        "pending_owner",
        "authorized",
        "archived",
        "mapped",
        "revoked",
        "owner_closed",
        "owner_disabled",
        "assignment_retained",
        "history_gap",
      ].includes(item.assignmentState) ||
      item.contentVerified !== false ||
      item.historicalUploaderVerified !== false ||
      (item.assignmentState === "unassigned" && item.ownerId !== null) ||
      (item.metadataState === "blocked" && typeof item.reason !== "string")
    )
      throw new Error("字体目录项待核对");
    before = item.ordinal;
  }
  if (v.nextAfter !== null && v.nextAfter !== v.items.at(-1)?.ordinal)
    throw new Error("字体目录游标待核对");
  return v;
}
export function fontCatalogHistory(raw: unknown) {
  const v = raw as { items: FontCatalogSummary[]; nextAfter: string | null };
  if (
    !v ||
    !Array.isArray(v.items) ||
    v.items.length > 20 ||
    (v.nextAfter !== null && !fontOperationId(v.nextAfter))
  )
    throw new Error("字体目录历史待核对");
  v.items.forEach(fontCatalogSummary);
  return v;
}
export function fontCatalogSources(raw: unknown) {
  const v = raw as {
    items: CatalogSource[];
    configuration: { state: "configured" | "not_configured" | "unavailable" };
    maxEntries: number;
  };
  if (
    !v ||
    !Array.isArray(v.items) ||
    v.items.length > 8 ||
    v.maxEntries !== 5000 ||
    !["configured", "not_configured", "unavailable"].includes(
      v.configuration?.state,
    ) ||
    v.items.some(
      (s) =>
        typeof s.sourceAlias !== "string" ||
        typeof s.sourceInstance !== "string" ||
        typeof s.window?.state !== "string",
    )
  )
    throw new Error("字体目录来源状态待核对");
  return v;
}
export function fontCatalogReceipt(raw: unknown, id: string) {
  const v = raw as FontCatalogReceipt;
  if (
    !v ||
    !fontOperationId(id) ||
    v.requestId !== id ||
    v.kind !== "catalog" ||
    !["reading", "completed", "failed"].includes(v.state) ||
    v.entireSourceComplete !== false ||
    (v.state === "completed" &&
      (!fontOperationId(v.catalogId ?? "") ||
        !hash.test(v.sha256 ?? "") ||
        v.canceled))
  )
    throw new Error("原目录操作回执待核对");
  return v;
}
export function catalogStatus(item: FontCatalogEntry) {
  return (
    {
      unassigned: "归属未分配",
      pending_owner: "待本人确认",
      authorized: "已授权，待捕获原件",
      archived: "本人原件已归档",
      mapped: "已映射本人字体",
      revoked: "本人许可已撤销",
      owner_closed: "所属账户已关闭，归属保留",
      owner_disabled: "所属账户已停用，归属保留",
      assignment_retained: "永久归属已保留",
      history_gap: "历史归属缺失，禁止重新分配",
    }[item.assignmentState] +
    (item.metadataState === "blocked" ? " · 原目录项不安全" : "")
  );
}
export function clearFontCatalogRequest(s: Store, keep?: string) {
  for (const k of Array.from({ length: s.length }, (_, i) => s.key(i)))
    if (k?.startsWith(prefix) && k !== prefix + keep) s.removeItem(k);
}
export function readFontCatalogRequest(s: Store, scope: string) {
  clearFontCatalogRequest(s, scope);
  const id = s.getItem(prefix + scope);
  if (id !== null && !fontOperationId(id))
    throw new Error("原目录操作编号无法读取");
  return id;
}
export function retainFontCatalogRequest(s: Store, scope: string, id: string) {
  if (!fontOperationId(id)) throw new Error("原目录编号无效");
  const prior = readFontCatalogRequest(s, scope);
  if (prior && prior !== id) throw new Error("请先核对原目录操作");
  s.setItem(prefix + scope, id);
}
export function releaseFontCatalogRequest(s: Store, scope: string, id: string) {
  if (s.getItem(prefix + scope) === id) s.removeItem(prefix + scope);
}
