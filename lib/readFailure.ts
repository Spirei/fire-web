/** Preserve a source/configuration error instead of calling it an empty result. */
export function readFailure(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const body = data as {error?:unknown;message?:unknown};
  const error = body.error;
  const value = typeof error === "string" ? error : error && typeof error === "object" ? (error as {message?:unknown}).message : body.message;
  return typeof value === "string" && value.trim() ? value.trim().slice(0,240) : fallback;
}
