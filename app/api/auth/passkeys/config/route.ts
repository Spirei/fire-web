import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { verifyAdminStepUp } from "@/lib/adminStepUp";
import { normalizePasskeyConfig, passkeyConfig, savePasskeyConfig, PasskeyConfigConflictError } from "@/lib/passkeys";
import { readJsonBody } from "@/lib/requestBody";
import { rateLimit } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function GET() {
  const { enabled, origin, name, revision } = passkeyConfig();
  return NextResponse.json({ enabled, origin, name, revision }, { headers: { "Cache-Control": "no-store" } });
}
export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "登录已过期，请重新登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  if (!rateLimit(`passkey-config:${user.id}`, 10, 900000)) return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  const body = await readJsonBody(request, 8192).catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求" }, { status: 400 });
  try {
    const config = normalizePasskeyConfig(body);
    if (body.expectedRevision !== undefined && typeof body.expectedRevision !== "string") throw new Error("登录设置版本无效，请刷新页面");
    const expectedRevision = body.expectedRevision ?? passkeyConfig().revision;
    if (expectedRevision !== passkeyConfig().revision) throw new PasskeyConfigConflictError();
    const verified = verifyAdminStepUp(user.id, body);
    if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: 403 });
    const saved = savePasskeyConfig(config, expectedRevision);
    logSecurityEvent(request, user.id, "auth.passkey.config", `enabled=${config.enabled}; origin=${config.origin}`);
    return NextResponse.json({ enabled: saved.enabled, origin: saved.origin, name: saved.name, revision: saved.revision }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "站点地址无效" }, { status: error instanceof PasskeyConfigConflictError ? 409 : 400 });
  }
}
