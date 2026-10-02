import type { SiteSettings } from "./types";

type SmtpSettings = Pick<SiteSettings, "smtpHost" | "smtpPort" | "smtpSecure" | "smtpUser" | "smtpPassword">;
export type SmtpDestination = { host: string; port: number; secure: boolean; user: string };

export class SmtpDestinationError extends Error {
  constructor() { super("SMTP 地址或账号已更改，请输入新配置的密码；原配置未修改"); }
}

export function sameSmtpDestination(a: SmtpDestination, b: SmtpDestination): boolean {
  const host = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");
  return host(a.host) === host(b.host) && a.port === b.port && a.secure === b.secure && a.user.trim() === b.user.trim();
}

function smtpDestination(settings: SmtpSettings): SmtpDestination {
  const port = Number(settings.smtpPort || process.env.SMTP_PORT || 587);
  return {
    host: settings.smtpHost || process.env.SMTP_HOST || "",
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 587,
    secure: settings.smtpHost ? settings.smtpSecure : process.env.SMTP_SECURE === "true",
    user: settings.smtpUser || process.env.SMTP_USER || ""
  };
}

/** Empty/redacted passwords may be reused only with the same SMTP endpoint and account. */
export function assertSmtpPasswordDestination(before: SmtpSettings, patch: Partial<SmtpSettings>): void {
  if (!["smtpHost", "smtpPort", "smtpSecure", "smtpUser"].some(key => patch[key as keyof SmtpSettings] !== undefined)) return;
  if (!(before.smtpPassword || process.env.SMTP_PASSWORD)) return;
  if (patch.smtpPassword?.trim() && patch.smtpPassword.trim() !== "********") return;
  const next = { ...before };
  for (const key of ["smtpHost", "smtpPort", "smtpUser"] as const) if (typeof patch[key] === "string") next[key] = patch[key].trim();
  if (typeof patch.smtpSecure === "boolean") next.smtpSecure = patch.smtpSecure;
  if (!sameSmtpDestination(smtpDestination(before), smtpDestination(next))) throw new SmtpDestinationError();
}
