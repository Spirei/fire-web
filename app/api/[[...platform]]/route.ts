import { platformConfig, platformRequest } from "@/lib/platformTransport";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 固定转交给 Fire 内置服务；业务路由、授权和请求预算由同一服务核验。 */
async function route(request: Request) {
  const url = new URL(request.url);
  try {
    const { publicOrigin } = platformConfig();
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !request.headers.has("authorization") &&
      request.headers.get("origin") !== publicOrigin.origin
    )
      return Response.json(
        { error: "请求来源不匹配" },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    const response = await platformRequest(url.pathname + url.search, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });
    if (
      response.status >= 400 &&
      !/^\/api\/(?:v\d+|fire)\//.test(url.pathname) &&
      response.headers.get("content-type")?.includes("application/json")
    ) {
      const value = await response.json();
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("etag");
      const detail = value?.error || value?.detail;
      if (detail && typeof detail === "object" && !Array.isArray(detail)) {
        return Response.json(
          {
            ...value,
            error:
              typeof detail.message === "string"
                ? detail.message
                : "请求未完成",
          },
          { status: response.status, headers },
        );
      }
      return Response.json(value, { status: response.status, headers });
    }
    return response;
  } catch {
    return Response.json(
      { error: "平台服务暂不可用" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
export {
  route as GET,
  route as POST,
  route as PUT,
  route as PATCH,
  route as DELETE,
  route as HEAD,
  route as OPTIONS,
};
