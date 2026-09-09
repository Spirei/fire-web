import { NextResponse } from "next/server";
import { getSiteSettings } from "@/lib/settings";

/** 站点域名：未手动配置（或仍为占位 localhost:3000）时按请求 Host 自动推导，
 *  内网访问时显示实际 IP 与端口，外网访问时显示公网域名。 */
function effectiveDomain(request: Request, stored: string): string {
  const host = request.headers.get("host") || "";
  const placeholder = stored === "localhost:3000" || !stored;
  return placeholder ? host || stored : stored;
}

export async function GET(request: Request) {
  const s = getSiteSettings();
  return NextResponse.json({
    settings: {
      title: s.title,
      ico: s.ico,
      homepageBg: s.homepageBg,
      loginSideImage: s.loginSideImage,
      domain: effectiveDomain(request, s.domain),
      siteLogo: s.siteLogo,
      logoText: s.logoText,
      logoFont: s.logoFont,
      footerDesc: s.footerDesc,
      homeNav: s.homeNav,
      allowRegister: s.allowRegister,
      marketBadges: s.marketBadges,
      marketBadgesVisible: s.marketBadgesVisible
    }
  });
}
