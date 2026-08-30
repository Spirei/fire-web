import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { clearAllRecords, createRecord, listRecords, logActivity } from "@/lib/store";
import { parseMarket, toNumberOrEmpty } from "@/lib/store";
import type { RecordInput } from "@/lib/types";
import { validateRecordFields } from "@/lib/recordValidation";
import { findUserById } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const records = listRecords(user.id);
  return NextResponse.json(records);
}

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  const name = String(body.name ?? "").trim();
  const code = String(body.code ?? "").trim();
  const price = toNumberOrEmpty(body.price);
  const cost = toNumberOrEmpty(body.cost);
  const qty = toNumberOrEmpty(body.qty);

  const validationError = validateRecordFields(name, code, price, qty);
  if (validationError) {
    // 现价允许为空：搜索添加的部分股票暂无实时价，创建后由行情刷新自动填充
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const input: RecordInput = {
    name,
    code,
    market: parseMarket(String(body.market ?? "OTHER")),
    price,
    cost,
    qty,
    group: String(body.group ?? "").trim().slice(0, 100),
    note: String(body.note ?? "").trim().slice(0, 500),
    source: String(body.source ?? "").trim().slice(0, 50)
  };

  const record = createRecord(user.id, input);
  logActivity(user.id, "created", record.name, record.code, {
    market: record.market,
    price: record.price,
    cost: record.cost,
    qty: record.qty
  });
  return NextResponse.json(record, { status: 201 });
}

export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`clear-records:${clientIp(request)}:${user.id}`, 5, 60 * 60 * 1000) || !rateLimitGlobal("clear-records", 50, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await request.json().catch(() => null);
  const row = findUserById(user.id);
  if (!row || !verifyPassword(String(body?.password ?? ""), row.password_hash)) {
    logSecurityEvent(request, user.id, "records_clear_rejected", "password verification failed");
    return NextResponse.json({ error: "当前密码错误" }, { status: 403 });
  }
  const cleared = clearAllRecords(user.id);
  logSecurityEvent(request, user.id, "records_clear", JSON.stringify(cleared));
  return NextResponse.json({ ok: true, ...cleared });
}
