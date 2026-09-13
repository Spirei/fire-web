import { NextResponse } from "next/server";
import { Client } from "pg";
import { getSiteSettings } from "@/lib/settings";
import { getAuthUser, isAdmin } from "@/lib/auth";

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  const host = String(body.host ?? "").trim();
  const port = Number(body.port) || 5432;
  const database = String(body.database ?? "").trim();
  const pgUser = String(body.pgUser ?? "").trim();
  const saved = getSiteSettings();
  const sameConnection = host === saved.pgHost && port === Number(saved.pgPort) && database === saved.pgDatabase && pgUser === saved.pgUser;
  const password = String(body.password || (sameConnection ? saved.pgPassword : ""));

  if (!host || !database || !pgUser) {
    return NextResponse.json({ error: "请填写主机、数据库名和用户名" }, { status: 400 });
  }

  const client = new Client({
    host,
    port,
    database,
    user: pgUser,
    password,
    connectionTimeoutMillis: 6000,
    ssl: false
  });

  try {
    await client.connect();
    const res = await client.query("SELECT version() AS v");
    const version = res.rows[0]?.v ?? "";
    await client.end();
    return NextResponse.json({ ok: true, version });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "连接失败" },
      { status: 400 }
    );
  }
}
