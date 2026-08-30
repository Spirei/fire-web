import { fail, ok } from "@/lib/api";
import { saveUpload, UploadError } from "@/lib/upload";

/** v1 文件上传（需登录；kind=avatar 头像人人可传，asset/ico/background/logo 仅管理员） */
export async function POST(request: Request) {
  try {
    const { url, kind } = await saveUpload(request);
    return ok({ url, kind });
  } catch (err) {
    if (err instanceof UploadError) {
      const code = err.status === 401 ? 40101 : err.status === 403 ? 40301 : 40001;
      return fail(code, err.message, err.status);
    }
    return fail(50001, "上传失败，请稍后重试", 500);
  }
}
