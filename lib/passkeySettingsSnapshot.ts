import { listPasskeys, passkeyConfig } from "@/lib/passkeys";
import { userTotpEnabled } from "@/lib/totpAuth";
import type { PasskeySettingsSnapshot } from "@/lib/passkeySettingsData";

/** Public metadata only; never serialize credential material or TOTP secrets. */
export function passkeySettingsSnapshot(userId: string): PasskeySettingsSnapshot {
  const { enabled, origin, name, revision } = passkeyConfig();
  return {
    config: { enabled, origin, name, revision },
    keys: listPasskeys(userId).map(row => ({ id: row.id, name: row.name, rpID: row.rp_id, createdAt: row.created_at, lastUsedAt: row.last_used_at, backedUp: !!row.backed_up })),
    totpEnabled: userTotpEnabled(userId)
  };
}
