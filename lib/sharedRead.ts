/** 仅合并正在进行的读取，不缓存结果；每位调用者有独立的响应体。 */
const pending = new Map<string, Promise<Response>>();

export function sharedRead(url: string): Promise<Response> {
  let request = pending.get(url);
  if (!request) {
    request = fetch(url, { cache: "no-store" }).finally(() => {
      if (pending.get(url) === request) pending.delete(url);
    });
    pending.set(url, request);
  }
  return request.then(response => response.clone());
}
