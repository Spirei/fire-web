import { fail, ok } from "@/lib/api";
import { saveUpload, UploadError } from "@/lib/upload";

/** App needs explicit profile.write and can upload only its own avatar. */
export async function POST(request: Request) {
  try {
    const { url, kind } = await saveUpload(request);
    return ok({ url, kind });
  } catch (err) {
    if (err instanceof UploadError) {
      const code = err.status >= 500 ? 50001 : err.status === 401 ? 40101 : err.status === 403 ? 40301 : err.status === 429 ? 42901 : 40001;
      return fail(code, err.message, err.status);
    }
    return fail(50001, "上传失败，请稍后重试", 500);
  }
}
