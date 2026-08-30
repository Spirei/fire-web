import { NextResponse } from "next/server";
import { deleteOtherSessions, getAuthUser, isAdmin, resetUserPassword } from "@/lib/auth";
import { validatePassword } from "@/lib/password";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = getAuthUser(request);
  if (!me) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(me)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const newPassword = String(body?.newPassword ?? "");
  const pwdErr = validatePassword(newPassword);
  if (pwdErr) {
    return NextResponse.json({ error: pwdErr }, { status: 400 });
  }
  const ok = resetUserPassword(id, newPassword);
  if (!ok) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  deleteOtherSessions(id, null);
  return NextResponse.json({ ok: true });
}
