import { gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);

/** 公开行情的 v1 信封：异步压缩，协商编码，不缓存个人请求标识。 */
export async function marketResponse(request: Request, data: unknown): Promise<Response> {
  const json = JSON.stringify({ code: 0, message: "ok", data });
  const bytes = Buffer.from(json);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, private",
    "Vary": "Accept-Encoding"
  };
  const encodings = (request.headers.get("accept-encoding") ?? "").toLowerCase().split(",");
  const gzipAllowed = encodings.some(value => {
    const [name, ...params] = value.trim().split(";");
    if (name !== "gzip") return false;
    const quality = params.map(p => p.trim()).find(p => p.startsWith("q="));
    return !quality || (Number(quality.slice(2)) > 0 && Number(quality.slice(2)) <= 1);
  });
  if (gzipAllowed && bytes.length >= 1024) {
    const packed = await compress(bytes);
    if (packed.length < bytes.length) {
      headers["Content-Encoding"] = "gzip";
      return new Response(packed, { headers });
    }
  }
  return new Response(bytes, { headers });
}
