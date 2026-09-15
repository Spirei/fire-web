import { readFormBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { readBrokerOrderSheet } from "@/lib/orderImportXlsx";
import { importBrokerOrders, type ImportOrderInput } from "@/lib/orderImport";
import { clientIp, rateLimit } from "@/lib/rateLimit";

const MAX_BYTES = 16 * 1024 * 1024;

/**
 * 订单导入：上传券商导出的 .xlsx（格式见 docs/broker-orders-format.md）。
 * 默认先 dry-run 预览（?dryRun=1），确认后再真实导入（不带 dryRun）。
 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`orders-import:${clientIp(request)}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "导入过于频繁，请稍后再试" }, { status: 429 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const form = await readFormBody(request).catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "请选择要导入的 xlsx 文件" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "文件过大，最大 16MB" }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  let sheet;
  try {
    sheet = readBrokerOrderSheet(buffer);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "无法解析 xlsx" }, { status: 422 });
  }
  if (sheet.rows.length === 0) {
    return NextResponse.json({ error: "文件中没有订单数据行" }, { status: 422 });
  }
  try {
    const result = importBrokerOrders(user.id, sheet.rows as ImportOrderInput[], dryRun);
    return NextResponse.json({
      dryRun,
      fileName: file.name,
      totalFilled: result.totalFilled,
      imported: result.imported,
      skipped: result.skipped,
      duplicated: result.duplicated,
      groups: result.groups
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "导入失败";
    return NextResponse.json({ error: `导入失败：${message}` }, { status: 500 });
  }
}
