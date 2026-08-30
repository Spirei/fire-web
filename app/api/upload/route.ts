import { NextResponse } from "next/server";
import { saveUpload, UploadError } from "@/lib/upload";

export async function POST(request: Request) {
  try {
    const { url } = await saveUpload(request);
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof UploadError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "上传失败，请稍后重试" }, { status: 500 });
  }
}
