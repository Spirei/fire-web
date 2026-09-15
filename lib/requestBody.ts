export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

async function limitedBytes(body: ReadableStream<Uint8Array> | null, declared: string | null, maxBytes: number): Promise<Uint8Array> {
  if (Number(declared) > maxBytes) throw new RequestBodyTooLargeError();
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new RequestBodyTooLargeError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function readLimitedResponseBytes(response: Response, maxBytes: number) {
  return limitedBytes(response.body, response.headers.get("content-length"), maxBytes);
}

/** Compatible route helpers: byte limits apply even without Content-Length. */
export function readJsonBody(request: Request, maxBytes = 10 * 1024 * 1024): Promise<any> {
  return readLimitedJson(request, maxBytes);
}

export async function readTextBody(request: Request, maxBytes = 10 * 1024 * 1024): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await limitedBytes(request.body, request.headers.get("content-length"), maxBytes));
}

export async function readFormBody(request: Request, maxBytes = 52 * 1024 * 1024): Promise<FormData> {
  const bytes = await limitedBytes(request.body, request.headers.get("content-length"), maxBytes);
  return new Response(bytes as BodyInit, { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData();
}

/** Read JSON without allowing an unbounded body to be buffered before validation. */
export async function readLimitedJson<T = unknown>(request: Request, maxBytes: number): Promise<T | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyTooLargeError();
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** Read a JSON response with a hard byte limit before parsing untrusted upstream data. */
export async function readLimitedResponseJson<T = unknown>(response: Response, maxBytes: number): Promise<T | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyTooLargeError();
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    return null;
  }
}
