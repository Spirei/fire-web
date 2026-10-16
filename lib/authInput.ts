import { readJsonBody } from "./requestBody";

/** Credentials are data, never coerced objects or a blacklist of SQL characters. */
export async function readAuthObject(request: Request, fields: readonly string[], maxBytes = 4096): Promise<Record<string, unknown> | null> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return null;
  const body: unknown = await readJsonBody(request, maxBytes).catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) return null;
  return body as Record<string, unknown>;
}

export function credentials(body: Record<string, unknown> | null): { username: string; password: string } | null {
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") return null;
  const username = body.username.trim(), password = body.password;
  if (!username || username.length > 254 || /[\x00-\x1f\x7f]/.test(username) || !password || password.length > 128) return null;
  return { username, password };
}

export function loginFactor(body: Record<string, unknown> | null): { ticket: string; code: string } | null {
  if (!body || typeof body.ticket !== "string" || typeof body.code !== "string"
      || !body.ticket || body.ticket.length > 256 || !body.code.trim() || body.code.length > 32) return null;
  return { ticket: body.ticket, code: body.code };
}
