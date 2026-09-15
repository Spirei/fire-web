import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { deleteRecord, listRecords, logActivity, parseMarket, toNumberOrEmpty, updateRecord } from "@/lib/store";
import type { RecordInput } from "@/lib/types";
import { validateRecordFields } from "@/lib/recordValidation";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  const body = await readJsonBody(request).catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  const name = String(body.name ?? "").trim();
  const code = String(body.code ?? "").trim();
  const price = toNumberOrEmpty(body.price);
  const cost = toNumberOrEmpty(body.cost);
  const qty = toNumberOrEmpty(body.qty);

  const validationError = validateRecordFields(name, code, price, qty);
  if (validationError) {
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

  const updated = updateRecord(id, user.id, input);
  if (!updated) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  logActivity(user.id, "updated", updated.name, updated.code, {
    market: updated.market,
    price: updated.price,
    cost: updated.cost,
    qty: updated.qty
  });
  return NextResponse.json(updated);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  const target = listRecords(user.id).find((r) => r.id === id);
  const ok = deleteRecord(id, user.id);
  if (!ok) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  if (target) {
    logActivity(user.id, "deleted", target.name, target.code, {
      market: target.market,
      price: target.price,
      cost: target.cost,
      qty: target.qty
    });
  }
  return NextResponse.json({ ok: true });
}
