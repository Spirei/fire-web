import { NextResponse } from "next/server";
import fs from "node:fs";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getSiteSettings, normalizeFutuHost, updateSiteSettings } from "@/lib/settings";
import { syncRecordGroups } from "@/lib/brokers";
import { localPathOf, removeFileIfUnused } from "@/lib/fileCleanup";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const settings = getSiteSettings();
  if (!isAdmin(user)) {
    // 非管理员隐藏数据库连接信息（密码等敏感配置）
    return NextResponse.json({
      settings: { ...settings, pgHost: "", pgPort: "", pgDatabase: "", pgUser: "", pgPassword: "" }
    });
  }
  return NextResponse.json({ settings });
}

export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  // 数据源地址仅允许 http(s)，防止配置成 file:// 或内网探测地址（管理端接口）
  const URL_KEYS = [
    "quoteApiUrl", "searchApiUrl", "chartApiUrl", "currencyApiUrl",
    "earningsApiUrl", "cnEarningsApiUrl", "usLogoApiUrl", "cnLogoApiUrl", "trumpArchiveApiUrl", "translationApiUrl"
  ] as const;
  for (const k of URL_KEYS) {
    if (body[k] !== undefined) {
      const value = String(body[k]).trim();
      if (value && !/^https?:\/\/[^\s]+$/i.test(value)) {
        return NextResponse.json({ error: `${k} 必须是 http(s):// 开头的地址` }, { status: 400 });
      }
    }
  }

  const before = getSiteSettings();
  const settings = updateSiteSettings({
    domain: body.domain !== undefined ? String(body.domain) : undefined,
    title: body.title !== undefined ? String(body.title) : undefined,
    ico: body.ico !== undefined ? String(body.ico) : undefined,
    homepageBg: body.homepageBg !== undefined ? String(body.homepageBg) : undefined,
    loginSideImage: body.loginSideImage !== undefined ? String(body.loginSideImage) : undefined,
    siteLogo: body.siteLogo !== undefined ? String(body.siteLogo) : undefined,
    logoText: body.logoText !== undefined ? String(body.logoText) : undefined,
    logoFont:
      body.logoFont === "diatype" || body.logoFont === "diatype-regular" || body.logoFont === "system"
        ? body.logoFont
        : undefined,
    quoteSource:
      body.quoteSource === "auto" || body.quoteSource === "futu" || body.quoteSource === "tencent"
        ? body.quoteSource
        : undefined,
    futuHost: body.futuHost !== undefined ? normalizeFutuHost(String(body.futuHost)) : undefined,
    futuPort: /^\d{1,5}$/.test(String(body.futuPort ?? "")) ? String(body.futuPort).trim() : undefined,
    footerDesc: body.footerDesc !== undefined ? String(body.footerDesc) : undefined,
    quoteApiUrl: body.quoteApiUrl !== undefined ? String(body.quoteApiUrl) : undefined,
    searchApiUrl: body.searchApiUrl !== undefined ? String(body.searchApiUrl) : undefined,
    chartApiUrl: body.chartApiUrl !== undefined ? String(body.chartApiUrl) : undefined,
    currencyApiUrl: body.currencyApiUrl !== undefined ? String(body.currencyApiUrl) : undefined,
    earningsApiUrl: body.earningsApiUrl !== undefined ? String(body.earningsApiUrl) : undefined,
    cnEarningsApiUrl: body.cnEarningsApiUrl !== undefined ? String(body.cnEarningsApiUrl) : undefined,
    usLogoApiUrl: body.usLogoApiUrl !== undefined ? String(body.usLogoApiUrl) : undefined,
    cnLogoApiUrl: body.cnLogoApiUrl !== undefined ? String(body.cnLogoApiUrl) : undefined,
    trumpArchiveApiUrl: body.trumpArchiveApiUrl !== undefined ? String(body.trumpArchiveApiUrl) : undefined,
    translationApiUrl: body.translationApiUrl !== undefined ? String(body.translationApiUrl) : undefined,
    translationEnabled: typeof body.translationEnabled === "boolean" ? body.translationEnabled : undefined,
    translationProvider: ["mymemory", "deepseek", "openai-compatible"].includes(body.translationProvider) ? body.translationProvider : undefined,
    deepseekApiUrl: body.deepseekApiUrl !== undefined ? String(body.deepseekApiUrl) : undefined,
    deepseekModel: body.deepseekModel !== undefined ? String(body.deepseekModel) : undefined,
    deepseekApiKey: body.deepseekApiKey !== undefined ? String(body.deepseekApiKey) : undefined,
    homeNav: Array.isArray(body.homeNav) ? body.homeNav : undefined,
    tabs: Array.isArray(body.tabs) ? body.tabs : undefined,
    groups: Array.isArray(body.groups) ? body.groups : undefined,
    markets: Array.isArray(body.markets) ? body.markets : undefined,
    marketLabels: Array.isArray(body.marketLabels) ? body.marketLabels : undefined,
    assetMarketOrder: Array.isArray(body.assetMarketOrder) ? body.assetMarketOrder : undefined,
    indicesOrder: Array.isArray(body.indicesOrder) ? body.indicesOrder : undefined,
    holdingColumns: Array.isArray(body.holdingColumns) ? body.holdingColumns : undefined,
    ticker: body.ticker && typeof body.ticker === "object" ? body.ticker : undefined,
    allowRegister: typeof body.allowRegister === "boolean" ? body.allowRegister : undefined,
    stockIconCdn: typeof body.stockIconCdn === "boolean" ? body.stockIconCdn : undefined,
    dbType: body.dbType === "sqlite" || body.dbType === "postgres" ? body.dbType : undefined,
    pgHost: body.pgHost !== undefined ? String(body.pgHost) : undefined,
    pgPort: body.pgPort !== undefined ? String(body.pgPort) : undefined,
    pgDatabase: body.pgDatabase !== undefined ? String(body.pgDatabase) : undefined,
    pgUser: body.pgUser !== undefined ? String(body.pgUser) : undefined,
    pgPassword: body.pgPassword !== undefined ? String(body.pgPassword) : undefined
  });
  if (Array.isArray(body.groups)) {
    syncRecordGroups(before.groups, settings.groups);
  }
  // 网站形象 / 站点 Logo 替换后删除旧本地文件，保留唯一（不堆积 ico / background / logo）
  ["ico", "homepageBg", "siteLogo"].forEach((k) => {
    const oldVal = before[k as keyof typeof before];
    const newVal = settings[k as keyof typeof settings];
    if (typeof oldVal === "string" && typeof newVal === "string" && oldVal !== newVal) {
      // 保护：仅当新值是「本地已存在的文件（真实上传）」或外部 URL 时才删旧文件；
      // 新值是本地但文件不存在（如测试占位 / 异常写入）时保留旧文件，避免误删用户资源
      const newIsLocal = /^\/uploads\//.test(newVal);
      let newExists = !newIsLocal;
      if (newIsLocal) {
        try {
          newExists = fs.existsSync(localPathOf(newVal));
        } catch {
          newExists = false;
        }
      }
      if (newExists) removeFileIfUnused(oldVal);
    }
  });
  return NextResponse.json({ settings });
}
