import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getUserFire, setUserFire } from "@/lib/fireStore";
import { validFireAssetAmount } from "@/lib/fireAssetHistory";
import { rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
const MAX_FIRE_BYTES = 256 * 1024;

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({ fire: getUserFire(user.id) ?? {} });
}

export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`fire:${user.id}`, 200, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "保存过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request).catch(() => null);
  const fire = body?.fire && typeof body.fire === "object" ? body.fire as Record<string, unknown> : null;
  if (!fire) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  // 历史年度以自然年为边界冻结。前端只读用于体验，服务端合并用于保证
  // 即使旧客户端或手工请求提交了改动，也不能覆盖已经结束年度的快照。
  const currentYear = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric" }).format(new Date()));
  const stored = getUserFire(user.id);
  if (Array.isArray(fire.tableRows) && Array.isArray(stored?.tableRows)) {
    const storedByYear = new Map(
      (stored.tableRows as Record<string, unknown>[])
        .filter((row) => Number(row?.year) < currentYear)
        .map((row) => [Number(row.year), row])
    );
    fire.tableRows = (fire.tableRows as Record<string, unknown>[]).map((row) => {
      const frozen = storedByYear.get(Number(row?.year));
      // 新增字段（例如旧数据补 target）允许补齐；已有历史字段仍以冻结快照为准。
      return frozen ? { ...row, ...frozen } : row;
    });
  }
  if (Buffer.byteLength(JSON.stringify(fire), "utf8") > MAX_FIRE_BYTES) {
    return NextResponse.json({ error: "数据过大" }, { status: 400 });
  }
  let assetRecord;
  if (body?.assetRecord != null) {
    const amountBase = Number(body.assetRecord.amountBase);
    const amountUsd = Number(body.assetRecord.amountUsd);
    const currency = String(body.assetRecord.currency ?? "");
    if (!validFireAssetAmount(amountBase, amountUsd, currency)) {
      return NextResponse.json({ error: "请输入有效的当前资产" }, { status: 400 });
    }
    assetRecord = { recordedAt: new Date().toISOString(), amountBase, amountUsd, currency };
  }
  const assetHistory = setUserFire(user.id, fire, assetRecord);
  return NextResponse.json({ ok: true, assetHistory });
}
