import { needsSetup } from "@/lib/auth";
import { ok } from "@/lib/api";

/** 公开接口：空实例首次启动时需要创建管理员。 */
export async function GET() {
  return ok({ needsSetup: needsSetup() });
}
