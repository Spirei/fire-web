import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, findUserById } from "@/lib/auth";
import { listPasskeys } from "@/lib/passkeys";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      id: string;
    }>;
  },
) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user))
    return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const { id } = await params;
  const current = getAuthUser(request);
  if (!current || current.id !== user.id || !isAdmin(current))
    return NextResponse.json({ error: "登录已变化" }, { status: 401 });
  if (!findUserById(id))
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  return NextResponse.json(
    {
      keys: listPasskeys(id).map((r) => ({
        id: r.id,
        name: r.name,
        rpID: r.rp_id,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      })),
    },
    { headers: { "Cache-Control": "no-store, private" } },
  );
}
