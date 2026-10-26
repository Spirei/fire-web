import { getDb } from "./db";
import { appSecurityStamp } from "./appAuth";
/** Read only: a worker cannot renew a token, expand permissions or substitute another device's grant. */
export function orderExecutionAuthorized(userId: string, grantId: string) {
  const db = getDb(), now = Date.now();
  const g = db.prepare(`SELECT g.*,u.password_hash,u.totp_secret,u.totp_enabled FROM app_grants g JOIN users u ON u.id=g.user_id WHERE g.id=? AND g.user_id=?`).get(grantId,userId) as {revoked_at:number|null;expires_at:number;created_at:number;scope:string;security_stamp:string;password_hash:string;totp_secret:string;totp_enabled:number;passkey_id:string|null}|undefined;
  return !!g && g.revoked_at === null && g.expires_at > now && g.created_at + 90*86400000 > now && g.scope.split(" ").includes("orders.write") && g.security_stamp === appSecurityStamp(g) && (!g.passkey_id || !!db.prepare("SELECT 1 FROM passkeys WHERE id=? AND user_id=?").get(g.passkey_id,userId));
}
