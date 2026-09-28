import { NextResponse } from "next/server";
import { getSiteSettings } from "@/lib/settings";
import { publicSiteDomain } from "@/lib/publicSiteUrl";

export async function GET() {
  const s = getSiteSettings();
  return NextResponse.json({
    settings: {
      title: s.title,
      ico: s.ico,
      homepageBg: s.homepageBg,
      loginSideImage: s.loginSideImage,
      domain: publicSiteDomain(s.domain),
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
