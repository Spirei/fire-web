import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

/** A fixed upstream only. Request URLs and forwarding headers never choose the authority. */
export function platformConfig() {
  const upstream = new URL("http://fire-internal");
  const socketPath = process.env.FIRE_PLATFORM_SOCKET;
  if (!socketPath) throw new Error("Fire 内置后端尚未启动");
  const publicOrigin = new URL(
    process.env.FIRE_PUBLIC_ORIGIN || "http://localhost:3000",
  );
  for (const url of [upstream, publicOrigin]) {
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("平台地址配置无效");
  }
  return { upstream, publicOrigin, socketPath };
}
const forward = [
  "cookie",
  "authorization",
  "origin",
  "x-csrf-token",
  "x-simple-ledger-user",
  "content-type",
  "content-length",
  "x-file-name",
  "accept",
  "range",
  "if-none-match",
  "if-modified-since",
  "x-request-id",
  "idempotency-key",
  "user-agent",
  "accept-language",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
];
const excluded = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
export async function platformRequest(
  path: string,
  options: {
    method?: string;
    headers?: HeadersInit;
    body?: ReadableStream<Uint8Array> | null;
    signal?: AbortSignal;
    internal?: boolean;
  } = {},
): Promise<Response> {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\r\n]/.test(path)
  )
    throw new Error("接口路径无效");
  const { upstream, publicOrigin, socketPath } = platformConfig();
  const target = new URL(path, upstream);
  if (target.origin !== upstream.origin) throw new Error("接口地址无效");
  const incoming = new Headers(options.headers);
  const headers: Record<string, string> = {};
  for (const key of forward) {
    const value = incoming.get(key);
    if (value) headers[key] = value;
  }
  for (const [key, value] of incoming)
    if (key.startsWith("x-alcor-")) headers[key] = value;
  headers.host = publicOrigin.host;
  headers["x-forwarded-host"] = publicOrigin.host;
  headers["x-forwarded-proto"] = publicOrigin.protocol.slice(0, -1);
  headers["accept-encoding"] = "identity";
  if (options.internal) headers.origin = publicOrigin.origin;
  const method = options.method || "GET";
  return await new Promise<Response>((resolve, reject) => {
    const request = (upstream.protocol === "https:" ? https : http).request(
      target,
      { socketPath, method, headers, signal: options.signal },
      (response) => {
        const result = new Headers();
        const connection = new Set(
          String(response.headers.connection || "")
            .toLowerCase()
            .split(",")
            .map((x) => x.trim()),
        );
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          const key = response.rawHeaders[i],
            value = response.rawHeaders[i + 1];
          if (
            !excluded.has(key.toLowerCase()) &&
            !connection.has(key.toLowerCase())
          )
            result.append(key, value);
        }
        result.set("cache-control", "private, no-store");
        const status = response.statusCode || 502;
        if (method === "HEAD" || [204, 205, 304].includes(status)) {
          response.resume();
          resolve(new Response(null, { status, headers: result }));
        } else
          resolve(
            new Response(
              Readable.toWeb(response) as ReadableStream<Uint8Array>,
              { status, headers: result },
            ),
          );
      },
    );
    request.setTimeout(60000, () => request.destroy(new Error("平台响应超时")));
    request.on("error", reject);
    if (options.body) {
      const input = Readable.fromWeb(
        options.body as import("node:stream/web").ReadableStream,
      );
      input.on("error", (error) => request.destroy(error));
      input.pipe(request);
      request.on("close", () => input.destroy());
    } else request.end();
  });
}
export async function platformJson<T>(
  path: string,
  headers?: HeadersInit,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const response = await platformRequest(path, { headers, internal: true, signal: options.signal });
  if (!response.ok) throw new PlatformError(response.status);
  return (await response.json()) as T;
}
export class PlatformError extends Error {
  constructor(public status: number) {
    super(
      status === 401
        ? "登录已失效"
        : status === 403
          ? "没有访问权限"
          : "平台服务暂不可用",
    );
  }
}
