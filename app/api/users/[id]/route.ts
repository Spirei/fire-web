import { NextResponse } from "next/server";
import { deleteUserById, getAuthUser, isAdmin, updateUserById } from "@/lib/auth";

const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = getAuthUser(request);
  if (!me) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(me)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  const patch: { username?: string; email?: string; role?: string } = {};
  if (body.username !== undefined) {
    const username = String(body.username).trim();
    if (username.length < 3 || username.length > 20 || !USERNAME_RE.test(username)) {
      return NextResponse.json({ error: "用户名需为 3-20 位字母、数字、下划线或中文" }, { status: 400 });
    }
    patch.username = username;
  }
  if (body.email !== undefined) {
    const email = String(body.email).trim();
    if (email !== "" && !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    }
    patch.email = email;
  }
  if (body.role !== undefined) {
    if (body.role !== "user" && body.role !== "admin") {
      return NextResponse.json({ error: "角色不正确" }, { status: 400 });
    }
    patch.role = body.role;
  }

  const updated = updateUserById(id, patch);
  if (!updated) return NextResponse.json({ error: "用户不存在或用户名已被使用" }, { status: 409 });
  return NextResponse.json({ user: updated });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = getAuthUser(request);
  if (!me) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(me)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const { id } = await params;
  if (id === me.id) return NextResponse.json({ error: "不能删除自己的账号" }, { status: 400 });
  const ok = deleteUserById(id);
  if (!ok) return NextResponse.json({ error: "用户不存在或系统需保留至少一个管理员" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
