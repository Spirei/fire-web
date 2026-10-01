import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getSiteSettings, updateSiteSettings } from "@/lib/settings";
import { clientSettings } from "@/lib/settingsClient";
import { ModelSettingsConflictError } from "@/lib/modelSettingsRevision";
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
  const revision = form.get("modelServicesRevision");
  if (revision === null) return NextResponse.json({ error: "缺少模型配置版本，请刷新后重新编辑" }, { status: 428 });
  if (revision !== before.modelServicesRevision) return NextResponse.json({ error: new ModelSettingsConflictError().message }, { status: 409 });
  let services;
  try {
    services = prepareModelServices(JSON.parse(String(form.get("modelServices") || "")), before);
    const target = services.find(item => item.id === serviceId);
    if (!target) throw new Error("模型服务不存在");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "模型服务格式无效" }, { status: 400 });
  }

  let url = "";
  try {
    ({ url } = await saveUpload(request));
    const next = services.map(item => item.id === serviceId ? { ...item, icon: url, icons: { ...item.icons, [item.provider]: url } } : item);
    const settings = updateSiteSettings({ modelServices: next }, before.modelServicesRevision);
    const activeIcons = new Set(settings.modelServices.flatMap(item => [item.icon, ...Object.values(item.icons || {})]).filter(Boolean));
    before.modelServices.forEach(item => {
      for (const icon of new Set([item.icon, ...Object.values(item.icons || {})])) {
        if (icon && !activeIcons.has(icon)) removeFileIfUnused(icon);
      }
    });
    return NextResponse.json({ url, settings: clientSettings(settings, true) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (url) removeFileIfUnused(url);
    if (error instanceof ModelSettingsConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof UploadError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "图标保存失败，请重试" }, { status: 500 });
  }
}
