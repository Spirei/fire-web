import { getSiteSettings } from "@/lib/settings";
import { ok } from "@/lib/api";

/** v1 公开站点设置（无需登录：标题 / 图标 / Logo / 域名 / 注册开关等） */
export async function GET() {
  const s = getSiteSettings();
  return ok({
    title: s.title,
    ico: s.ico,
    homepageBg: s.homepageBg,
    domain: s.domain,
    siteLogo: s.siteLogo,
    logoText: s.logoText,
    logoFont: s.logoFont,
    footerDesc: s.footerDesc,
    homeNav: s.homeNav,
    allowRegister: s.allowRegister
  });
}
