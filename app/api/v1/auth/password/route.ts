import { fail, ok } from "@/lib/api";
import { changeOwnPassword, PasswordChangeError } from "@/lib/passwordChange";

export async function POST(request: Request) {
  try { return ok(await changeOwnPassword(request, true)); }
  catch (error) {
    return fail(error instanceof PasswordChangeError ? error.code : 50001, error instanceof PasswordChangeError ? error.message : "密码修改失败，请稍后再试", error instanceof PasswordChangeError ? error.status : 500);
  }
}
