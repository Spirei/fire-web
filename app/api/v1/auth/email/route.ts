import { fail, ok } from "@/lib/api";
import { appProfile } from "@/lib/appProfile";
import { ProfileError, saveProfile } from "@/lib/profileUpdate";

/** Any live owner connection can change its email after password verification. */
export async function PUT(request: Request) {
  try { return ok(appProfile(request, await saveProfile(request, true, true))); }
  catch (error) {
    const status = error instanceof ProfileError ? error.status : 500;
    return fail(error instanceof ProfileError ? error.code : 50001, error instanceof ProfileError ? error.message : "邮箱保存失败，请稍后再试", status);
  }
}
