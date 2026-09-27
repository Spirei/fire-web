import { passkeyRead } from "@/lib/passkeyClient";
import { isPublicPasskeyConfig, type PublicPasskeyConfig } from "@/lib/passkeyConfig";

export type SettingsPasskey = { id: string; name: string; rpID: string; createdAt: number; lastUsedAt: number | null; backedUp: boolean };
export type PasskeySettingsSnapshot = { config: PublicPasskeyConfig; keys: SettingsPasskey[]; totpEnabled: boolean };

/** Memory only, scoped to one mounted settings page; never share across accounts. */
export function createPasskeySettingsData(initial: PasskeySettingsSnapshot | null = null) {
  let snapshot: PasskeySettingsSnapshot | null = initial;
  let expires = initial ? Date.now() + 10_000 : 0;
  let flight: Promise<PasskeySettingsSnapshot> | null = null;
  let controller: AbortController | null = null;
  function invalidate() {
    snapshot = null; expires = 0;
    controller?.abort(); controller = null; flight = null;
  }
  function read(force = false): Promise<PasskeySettingsSnapshot> {
    if (force) invalidate();
    if (flight) return flight;
    if (snapshot && Date.now() < expires) return Promise.resolve(snapshot);
    const request = new AbortController(); controller = request;
    const pending = Promise.all([
      passkeyRead("/api/auth/passkeys/config", request.signal),
      passkeyRead("/api/auth/passkeys", request.signal)
    ]).then(([config, list]) => {
      if (!isPublicPasskeyConfig(config) || !Array.isArray(list.keys) || typeof list.totpEnabled !== "boolean") throw new Error("通行密钥响应异常，请重试");
      if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const value = { config, keys: list.keys as SettingsPasskey[], totpEnabled: list.totpEnabled };
      snapshot = value; expires = Date.now() + 10_000;
      return value;
    }).finally(() => { if (controller === request) { flight = null; controller = null; } });
    flight = pending;
    return pending;
  }
  // Expiry triggers revalidation, not an empty first frame. Writes and account
  // changes still invalidate the snapshot; actions wait for read() to complete.
  return { read, invalidate, peek: () => snapshot, preload: () => { void read().catch(() => {}); } };
}
export type PasskeySettingsData = ReturnType<typeof createPasskeySettingsData>;
