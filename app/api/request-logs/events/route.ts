import { getAuthUser, isAdmin } from "@/lib/auth";
import { fail } from "@/lib/api";
import { observeRequestLogs, requestLogRevision } from "@/lib/apiRequestLog";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  let dispose = () => {};
  let push = () => {};
  const unsubscribe = observeRequestLogs(() => push());
  if (!unsubscribe) return fail(42901, "实时连接过多", 429);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false, revision = -1;
      const close = () => {
        if (closed) return; closed = true; unsubscribe(); clearInterval(timer);
        request.signal.removeEventListener("abort", close);
        try { controller.close(); } catch { /* Already cancelled. */ }
      };
      dispose = close;
      push = () => {
        if (closed) return;
        try { const next = requestLogRevision(); if (next !== revision) { revision = next; controller.enqueue(encoder.encode(`event: change\ndata: ${revision}\n\n`)); } }
        catch { close(); }
      };
      const timer = setInterval(() => {
        try {
          if (!isAdmin(getAuthUser(request))) { close(); return; }
          push();
          if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch { close(); }
      }, 15_000);
      timer.unref();
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close(); else push();
    },
    cancel() { dispose(); }
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-store, private",
    Connection: "keep-alive", "X-Accel-Buffering": "no"
  } });
}
