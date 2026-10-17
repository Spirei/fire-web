import { getDb } from "./db";
import { getSiteSettings } from "./settings";
import type { GroupConfig } from "./types";
/** Personal IDs stay stable across labels; shared catalog remains unchanged. */
export function ownedBrokerGroups(userId:string):GroupConfig[] {
  const personal=getDb().prepare("SELECT id,name FROM broker_accounts WHERE user_id=? ORDER BY created_at,id").all(userId) as {id:string;name:string}[];
  return [...getSiteSettings().groups,...personal];
}
