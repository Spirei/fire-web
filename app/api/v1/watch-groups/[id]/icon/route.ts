import { ok, fail } from "@/lib/api";
import { saveWatchGroupIcon, UploadError } from "@/lib/upload";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return ok({ group: await saveWatchGroupIcon(request, (await params).id) }); }
  catch (error) {
    if (error instanceof UploadError) return fail(error.status * 100 + 1, error.message, error.status);
    return fail(50001, "分组图标保存失败，请重试", 500);
  }
}
