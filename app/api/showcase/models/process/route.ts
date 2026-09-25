import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { cancelModelProcessing, listProcessingJobs, queueModelProcessing } from "@/lib/showcaseProcessing";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { readBinaryBody, RequestBodyTooLargeError } from "@/lib/requestBody";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const denied = (request: Request, mutation = false) => {
  const user = getAuthUser(request);
  return !user ? NextResponse.json({ error: "未登录" }, { status: 401 }) : !isAdmin(user) || (mutation && !isTrustedMutationRequest(request)) ? NextResponse.json({ error: "无权处理车型" }, { status: 403 }) : null;
};
export async function GET(request: Request) {
  const error = denied(request); if (error) return error;
  const modelId = new URL(request.url).searchParams.get("modelId");
  return NextResponse.json({ job: listProcessingJobs().find(job => job.modelId === modelId) ?? null }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  const error = denied(request, true); if (error) return error;
  if (!rateLimit(`showcase-process:${clientIp(request)}`, 8, 3_600_000)) return NextResponse.json({ error: "提交过于频繁" }, { status: 429 });
  try {
    const body = JSON.parse(Buffer.from(await readBinaryBody(request, 4096)).toString("utf8"));
    if (typeof body?.modelId !== "string") return NextResponse.json({ error: "缺少车型" }, { status: 400 });
    return NextResponse.json({ job: queueModelProcessing(body.modelId) });
  } catch (cause) { return NextResponse.json({ error: cause instanceof RequestBodyTooLargeError ? "请求过大" : cause instanceof Error ? cause.message : "创建任务失败" }, { status: cause instanceof RequestBodyTooLargeError ? 413 : 400 }); }
}
export async function DELETE(request: Request) {
  const error = denied(request, true); if (error) return error;
  try {
    const body = JSON.parse(Buffer.from(await readBinaryBody(request, 4096)).toString("utf8"));
    if (typeof body?.jobId !== "string") return NextResponse.json({ error: "缺少任务" }, { status: 400 });
    return NextResponse.json({ job: cancelModelProcessing(body.jobId) });
  } catch (cause) { return NextResponse.json({ error: cause instanceof RequestBodyTooLargeError ? "请求过大" : cause instanceof Error ? cause.message : "取消失败" }, { status: cause instanceof RequestBodyTooLargeError ? 413 : 400 }); }
}
