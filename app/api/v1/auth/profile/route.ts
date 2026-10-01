import { fail, ok } from "@/lib/api";
import { appProfile } from "@/lib/appProfile";
import { ProfileError, saveProfile } from "@/lib/profileUpdate";

export async function PUT(request: Request) {
  try { return ok(appProfile(request, await saveProfile(request, true))); }
  catch (error) {
    const status = error instanceof ProfileError ? error.status : 500;
    return fail(status * 100 + 1, error instanceof ProfileError ? error.message : "资料保存失败，请稍后再试", status);
  }
}
