// Earlier Web releases kept these values on the device without an account ID.
const fields = [
  ["fire:p-expense", "annualExpense"],
  ["fire:p-withdrawal", "withdrawalRate"],
  ["fire:p-return", "annualReturn"],
  ["fire:p-inflation", "inflation"],
  ["fire:p-savings", "savingsRate"],
  ["fire:fire-target-base", "fireTargetBase"],
  ["fire:fire-target-usd", "fireTargetUsd"],
  ["fire:fire-current-ovr", "currentInput"],
  ["fire:fire-passive", "passiveInput"],
  ["fire:fire-original", "originalInput"],
  ["fire:fire-years", "yearsInput"],
  ["fire:fire-table", "tableRows"],
  ["fire:fire-asset-history", "assetHistory"],
] as const;

export function hasLegacyBrowserFirePlan(storage: Storage) {
  return fields.some(([key]) => Object.prototype.hasOwnProperty.call(storage, key));
}

export function exportLegacyBrowserFirePlan(storage: Storage) {
  const values: Record<string, string> = {};
  const plan: Record<string, unknown> = {};
  let valid = true;
  for (const [key, name] of [...fields, ["fire:base-currency", "baseCurrency"] as const]) {
    const raw = storage.getItem(key);
    if (raw === null) continue;
    values[key] = raw;
    try {
      plan[name] = name.endsWith("Input") ? raw : JSON.parse(raw);
    } catch {
      valid = false;
    }
  }
  // Keep the original strings even when an old browser value is damaged.
  const backup = valid ? {
    format: "fire-site-backup", version: 2, data: { userSettings: [{ fire: JSON.stringify(plan) }] },
    legacyBrowserValues: values,
  } : { format: "fire-browser-plan-originals", version: 1, legacyBrowserValues: values };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "FIRE-本机旧规划.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
