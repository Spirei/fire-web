import { getAuthUser } from "./auth";
import { channel } from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";
import { recordRequest, requestRoute, requestSource } from "./apiRequestLog";

type Message = { request: IncomingMessage; response: ServerResponse };
const installed = Symbol.for("fire.apiRequestInstrumentation");
const shared = globalThis as typeof globalThis & { [installed]?: boolean };

export function installRequestInstrumentation() {
  if (shared[installed]) return;
  shared[installed] = true;
  const requests = new WeakMap<IncomingMessage, { userId?: string; at: number; start: number; path: string; method: string; source: ReturnType<typeof requestSource> }>();
  const finish = (request: IncomingMessage, response: ServerResponse, aborted = false) => {
    const started = requests.get(request); if (!started) return;
    requests.delete(request);
    try { recordRequest({ at: started.at, path: started.path, method: started.method, source: started.source,
      userId: started.userId, status: aborted ? 499 : response.statusCode, duration: Math.max(0, Math.round((performance.now() - started.start) * 10) / 10) }); } catch { /* Telemetry must never break the response. */ }
  };
  channel("http.server.request.start").subscribe(value => {
    try {
      const { request, response } = value as Message;
      const path = requestRoute(request.url || ""); if (!path) return;
      const rawMethod = request.method || "GET";
      const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(rawMethod) ? rawMethod : "OTHER";
      let userId: string | undefined;
      try { const headers = new Headers(); for (const key of ['cookie','authorization','host','origin','sec-fetch-site']) { const value=request.headers[key]; if(typeof value==='string')headers.set(key,value); } userId=getAuthUser(new Request(`http://${request.headers.host||'localhost'}${request.url||'/'}`,{headers,method:request.method||'GET'}))?.id; } catch { /* Unverifiable identity stays unassigned. */ }
      requests.set(request, { userId, at: Date.now(), start: performance.now(), path, method, source: requestSource(request.headers) });
      response.once("close", () => { if (!response.writableFinished) finish(request, response, true); });
    } catch { /* Diagnostics-channel subscribers may not throw. */ }
  });
  channel("http.server.response.finish").subscribe(value => {
    try { const { request, response } = value as Message; finish(request, response); } catch { /* Preserve the real API result. */ }
  });
}
