import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { clearTotp, userTotpEnabled } from "@/lib/totpAuth";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = getAuthUser(request);
  if (!me) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(me)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const { id } = await params;
  if (!userTotpEnabled(id)) return NextResponse.json({ error: "该用户未开启二次验证" }, { status: 400 });
  clearTotp(id);
  logSecurityEvent(request, me.id, "auth.totp.admin_disabled", `user=${id}`);
  return NextResponse.json({ ok: true });
}
