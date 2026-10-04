import { resourceLibraryDiscovery } from "./resourceLibraryConfig";
import { APP_CLIENT_ID, APP_REDIRECT_URI, APP_SCOPE, APP_SUPPORTED_SCOPES, assertAppOrigin } from "./appAuth";
import { securityDiscovery } from "./appSecurityConfig";
import { fail, ok } from "./api";
import { marketCalendarDiscovery } from "./marketCalendar";
import { nativeLoginDiscovery } from "./appNativeLoginConfig";
import { recordsDiscovery } from "./recordsContract";
import { quoteSubscriptionsDiscovery } from "./quoteDemand";

export function appConfiguration(request:Request,version:1|2=1) {
  try { assertAppOrigin(request); } catch(error) { return fail(40301,(error as Error).message,403); }
  const base=`/api/v${version}`;
  return ok({version,api_versions_supported:[1,2],app_api_version:2,app_api_base_path:"/api/v2",
    quote_subscriptions_contract:quoteSubscriptionsDiscovery(),
    records_contract:recordsDiscovery(version),resource_library:resourceLibraryDiscovery(version),security:securityDiscovery(version),market_calendar:marketCalendarDiscovery(),native_login:nativeLoginDiscovery(),client_id:APP_CLIENT_ID,redirect_uri:APP_REDIRECT_URI,scope:APP_SCOPE,
    scopes_supported:APP_SUPPORTED_SCOPES,profile_path:`${base}/auth/profile`,upload_path:`${base}/upload`,
    email_path:`${base}/auth/email`,password_path:`${base}/auth/password`,feed_path:`${base}/feed`,feed_scopes:["feed.read","feed.write"],
    feed_contract:{version:1,groups_path:`${base}/feed/groups`,subscriptions_test_path:`${base}/feed/subscriptions/test`},
    authorization_path:"/app/authorize",authorization_submit_path:"/api/v1/auth/authorize",
    token_path:`${base}/auth/token`,revoke_path:`${base}/auth/revoke`,devices_path:"/app/devices",code_challenge_methods_supported:["S256"]});
}
