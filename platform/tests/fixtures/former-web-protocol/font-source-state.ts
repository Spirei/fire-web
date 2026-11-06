import { isPersonalFontId } from "./personal-font-id.ts";
import { personalFont, fontOperationId } from "./personal-font-state.ts";
import type { PersonalFont } from "./personal-font-state.ts";
import type { SourceWindow } from "./source-window-view.ts";
type Store = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
const prefix = "alcor.font-source-request:",
  hash = /^[a-f0-9]{64}$/;
export type FontSourcePermission = {
  id: string;
  grantId: string;
  ownerId: string;
  sourceAlias: string;
  sourceOwner: string;
  sourceInstance: string;
  originalId: string;
  scope: "fonts.migrate";
  state: "pending_owner" | "active" | "revoked";
  revision: number;
  name: string | null;
  evidenceRef: string;
  historicalUploaderVerified: false;
  ownershipEvidence: "admin-and-owner-attested";
  window?: SourceWindow;
};
export type FontCapture = {
  id: string;
  requestId: string;
  permissionId: string;
  permissionRevision: number;
  sha256: string;
  size: number;
  evidenceSha256: string;
  originalPath: string;
  historicalUploaderVerified: false;
  entireSourceComplete: false;
};
export type FontGrantOption = {
  grantId: string;
  grantRevision: number;
  ownerId: string;
  username: string;
  sourceAlias: string;
  sourceOwner: string;
  window: SourceWindow;
};
export type FontSourceListing = {
  items: FontSourcePermission[];
  captures: FontCapture[];
  entireSourceComplete: false;
  limit: 100;
};
export type FontSourcePlan = {
  captureId: string;
  permissionId: string;
  permissionRevision: number;
  expectedRevision: number;
  sha256: string;
  size: number;
  name: string;
  originalId: string;
  evidenceSha256: string;
  action: "already_mapped" | "import";
  targetId: string | null;
  historicalUploaderVerified: false;
  entireSourceComplete: false;
};
export type FontSourceKind = "register" | "consent" | "capture" | "apply";
export type FontSourceReceipt = {
  requestId: string;
  kind: FontSourceKind;
  state: "reading" | "completed" | "failed";
  permission?: FontSourcePermission;
  capture?: FontCapture;
  font?: PersonalFont;
  canceled?: boolean;
  message?: string;
  reason?: string;
};
const positive = (v: number) => Number.isSafeInteger(v) && v > 0;
function checkPermission(p: FontSourcePermission) {
  if (
    !p ||
    !fontOperationId(p.id) ||
    !fontOperationId(p.grantId) ||
    typeof p.ownerId !== "string" ||
    !p.ownerId ||
    !isPersonalFontId(p.originalId) ||
    p.scope !== "fonts.migrate" ||
    !["pending_owner", "active", "revoked"].includes(p.state) ||
    !positive(p.revision) ||
    p.historicalUploaderVerified !== false ||
    p.ownershipEvidence !== "admin-and-owner-attested" ||
    typeof p.evidenceRef !== "string" ||
    !p.evidenceRef ||
    typeof p.sourceAlias !== "string" ||
    typeof p.sourceOwner !== "string" ||
    typeof p.sourceInstance !== "string" ||
    (p.name !== null && (typeof p.name !== "string" || !p.name))
  )
    throw new Error("字体迁移许可待核对");
  return p;
}
export function fontCapture(c: FontCapture) {
  if (
    !c ||
    ![c.id, c.requestId, c.permissionId].every(fontOperationId) ||
    !positive(c.permissionRevision) ||
    !hash.test(c.sha256) ||
    !hash.test(c.evidenceSha256) ||
    !Number.isSafeInteger(c.size) ||
    c.size < 48 ||
    c.size > 10485760 ||
    c.historicalUploaderVerified !== false ||
    c.entireSourceComplete !== false ||
    c.originalPath !==
      "/api/personal-font-import/captures/" + c.id + "/original"
  )
    throw new Error("已归档字体原件待核对");
  return c;
}
export function fontSourceListing(raw: unknown): FontSourceListing {
  const v = raw as FontSourceListing;
  if (
    !v ||
    !Array.isArray(v.items) ||
    !Array.isArray(v.captures) ||
    v.entireSourceComplete !== false ||
    v.limit !== 100 ||
    v.items.length > 100 ||
    v.captures.length > 100
  )
    throw new Error("字体来源范围待核对");
  v.items.forEach(checkPermission);
  v.captures.forEach(fontCapture);
  if (
    new Set(v.items.map((p) => p.id)).size !== v.items.length ||
    new Set(v.captures.map((c) => c.id)).size !== v.captures.length
  )
    throw new Error("字体来源编号重复");
  return v;
}
export function fontSourceOptions(raw: unknown) {
  const v = raw as { items: FontGrantOption[] };
  if (
    !v ||
    !Array.isArray(v.items) ||
    v.items.length > 200 ||
    v.items.some(
      (g) =>
        !fontOperationId(g.grantId) ||
        !positive(g.grantRevision) ||
        ![g.ownerId, g.username, g.sourceAlias, g.sourceOwner].every(
          (s) => typeof s === "string" && !!s,
        ) ||
        typeof g.window?.state !== "string",
    )
  )
    throw new Error("可登记来源待核对");
  return v.items;
}
export function fontSourceAvailability(raw: unknown): string {
  const state = (raw as { configuration?: { state?: unknown } })?.configuration
    ?.state;
  switch (state) {
    case "configured":
      return "";
    case "not_configured":
      return "尚未配置旧字体来源";
    case "unavailable":
      return "旧字体来源配置不可用";
    default:
      return "旧字体来源配置待核对";
  }
}
export function fontSourceProof(raw: unknown, capture: FontCapture) {
  const v = raw as { plan: FontSourcePlan; preview: string },
    p = v?.plan;
  fontCapture(capture);
  if (
    !p ||
    !hash.test(v.preview) ||
    p.captureId !== capture.id ||
    p.permissionId !== capture.permissionId ||
    p.permissionRevision !== capture.permissionRevision ||
    p.sha256 !== capture.sha256 ||
    p.size !== capture.size ||
    p.evidenceSha256 !== capture.evidenceSha256 ||
    !Number.isSafeInteger(p.expectedRevision) ||
    p.expectedRevision < 0 ||
    p.historicalUploaderVerified !== false ||
    p.entireSourceComplete !== false ||
    !isPersonalFontId(p.originalId) ||
    p.originalId.split("-").pop()?.split(".")[0] !== p.sha256 ||
    (p.action !== "import" && p.action !== "already_mapped") ||
    (p.targetId !== null && !isPersonalFontId(p.targetId)) ||
    (p.action === "already_mapped" && !p.targetId) ||
    (p.action === "import" && p.targetId !== null) ||
    typeof p.name !== "string" ||
    !p.name
  )
    throw new Error("字体导入预览待核对");
  return v;
}
export function fontSourceReceipt(
  raw: unknown,
  request: string,
): FontSourceReceipt {
  const v = raw as FontSourceReceipt;
  if (
    !v ||
    !fontOperationId(request) ||
    v.requestId !== request ||
    !["register", "consent", "capture", "apply"].includes(v.kind) ||
    !["reading", "completed", "failed"].includes(v.state) ||
    (v.state === "reading" && v.kind !== "capture") ||
    (v.message !== undefined && typeof v.message !== "string") ||
    (v.reason !== undefined && typeof v.reason !== "string")
  )
    throw new Error("原字体来源回执待核对");
  if (v.state === "completed") {
    if (v.kind === "register" || v.kind === "consent")
      checkPermission(v.permission!);
    if (v.kind === "capture") fontCapture(v.capture!);
    if (v.kind === "apply") personalFont(v.font);
    if (v.canceled) throw new Error("已关闭操作不能显示完成");
  }
  return v;
}
export function clearFontSourceRequest(s: Store, keep?: string) {
  for (const k of Array.from({ length: s.length }, (_, i) => s.key(i)))
    if (k?.startsWith(prefix) && k !== prefix + keep) s.removeItem(k);
}
export function readFontSourceRequest(s: Store, scope: string) {
  clearFontSourceRequest(s, scope);
  const id = s.getItem(prefix + scope);
  if (id !== null && !fontOperationId(id))
    throw new Error("原字体来源编号无法读取");
  return id;
}
export function retainFontSourceRequest(s: Store, scope: string, id: string) {
  if (!fontOperationId(id)) throw new Error("原操作编号无效");
  const old = readFontSourceRequest(s, scope);
  if (old && old !== id) throw new Error("请先核对原字体来源操作");
  s.setItem(prefix + scope, id);
}
export function releaseFontSourceRequest(s: Store, scope: string, id: string) {
  if (s.getItem(prefix + scope) === id) s.removeItem(prefix + scope);
}
