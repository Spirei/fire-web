import { assetGrant } from "@/lib/appAssetsApi";
import { fail, ok } from "@/lib/api";
import { RecordsError } from "@/lib/recordsContract";
import { socialChannelsSnapshot } from "@/lib/socialChannels";

export const dynamic = "force-dynamic";

/** App reads which social channels are configured. Secrets are never included. */
export function GET(request: Request) {
  try {
    if (new URL(request.url).search) throw new RecordsError("不支持查询参数");
    assetGrant(request, "portfolio.read");
    const response = ok(socialChannelsSnapshot());
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const status = error instanceof RecordsError ? error.status : 500;
    return fail(status * 100 + 1, error instanceof RecordsError ? error.message : "通知配置读取失败", status);
  }
}
