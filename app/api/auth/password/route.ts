import { NextResponse } from "next/server";
import { changeOwnPassword, PasswordChangeError } from "@/lib/passwordChange";

export async function POST(request: Request) {
  try {
    const { ok, signedOutOthers } = await changeOwnPassword(request);
    return NextResponse.json({ ok, signedOutOthers }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof PasswordChangeError ? error.message : "密码修改失败，请稍后再试" }, { status: error instanceof PasswordChangeError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}
