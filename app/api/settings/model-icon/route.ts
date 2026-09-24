import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getSiteSettings, updateSiteSettings } from "@/lib/settings";
import { clientSettings } from "@/lib/settingsClient";
import { prepareModelServices } from "@/lib/modelServices";
import { removeFileIfUnused } from "@/lib/fileCleanup";
import { readFormBody } from "@/lib/requestBody";
import { saveUpload, UploadError } from "@/lib/upload";

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  const form = await readFormBody(request.clone(), 3 * 1024 * 1024).catch(() => null);
  if (!form || form.get("kind") !== "asset" || form.get("folder") !== "icon") {
    return NextResponse.json({ error: "无效的图标上传请求" }, { status: 400 });
  }
  const serviceId = String(form.get("serviceId") || "");
  const before = getSiteSettings();
  let services;
  try {
    services = prepareModelServices(JSON.parse(String(form.get("modelServices") || "")), before);
    if (!services.some(item => item.id === serviceId)) throw new Error("模型服务不存在");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "模型服务格式无效" }, { status: 400 });
  }

  let url = "";
  try {
    ({ url } = await saveUpload(request));
    const next = services.map(item => item.id === serviceId ? { ...item, icon: url } : item);
    const settings = updateSiteSettings({ modelServices: next });
    const activeIcons = new Set(settings.modelServices.map(item => item.icon).filter(Boolean));
    before.modelServices.forEach(item => { if (item.icon && !activeIcons.has(item.icon)) removeFileIfUnused(item.icon); });
    return NextResponse.json({ url, settings: clientSettings(settings, true) });
  } catch (error) {
    if (url) removeFileIfUnused(url);
    if (error instanceof UploadError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "图标保存失败，请重试" }, { status: 500 });
  }
}
