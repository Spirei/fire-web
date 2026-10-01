import { NextResponse } from "next/server";
import { ProfileError, saveProfile } from "@/lib/profileUpdate";

export async function PUT(request: Request) {
  try {
    return NextResponse.json({ user: await saveProfile(request) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ProfileError ? error.message : "资料保存失败，请稍后再试" }, { status: error instanceof ProfileError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}
