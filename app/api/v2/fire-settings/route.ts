import * as legacy from "@/app/api/v1/fire-settings/route";
import { appV2Response } from "@/lib/appApiV2";
import { fail, ok } from "@/lib/api";
export const dynamic = "force-dynamic";
/** v1 keeps its historical shape; v2 publishes an ordinary JSON envelope. */
async function envelop(response: Response) {
  const body = await response.json();
  if (response.ok) return ok(body);
  const code = ({400:40001,401:40101,403:40301,429:42901} as Record<number,number>)[response.status] ?? 50001;
  return fail(code, response.status < 500 && typeof body.error === "string" ? body.error : "设置操作失败，请稍后重试", response.status);
}
export async function GET(request: Request) { return appV2Response(request, async () => envelop(await legacy.GET(request))); }
export async function PUT(request: Request) { return appV2Response(request, async () => envelop(await legacy.PUT(request))); }
