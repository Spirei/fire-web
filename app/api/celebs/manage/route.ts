import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { listCelebRows, seedCelebsIfEmpty } from "@/lib/celebsStore";
import { getCelebAvatars } from "@/lib/celebsData";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  seedCelebsIfEmpty();
  const avatars = getCelebAvatars();
  const celebs = listCelebRows(false).map((c) => (avatars[c.id] ? { ...c, avatar: avatars[c.id] } : c));
  return NextResponse.json({ celebs });
}
