/**
 * 首页 3D 素材的持久化缓存。
 *
 * 背景：车模约 20 MB，浏览器 HTTP 缓存并不保证留住它（实测加了 immutable 之后刷新仍是整包重下）。
 * 两种情况分别处理：
 * 1) 线上是 HTTPS（安全上下文）→ 用 Cache Storage（Cache API）：按 URL 存整条响应，
 *    由浏览器统一做容量管理与 LRU 淘汰，将来接 Service Worker 也能直接复用；
 * 2) 局域网 HTTP 访问拿不到 Cache API → 回退到 IndexedDB 存字节流。
 * 两条路径都是「首次下载后写入、之后刷新直接命中」，读写失败一律回退成普通请求，不影响加载。
 */

const DB_NAME = "fire-showcase-assets";
const STORE = "files";
const DB_VERSION = 1;
const CACHE_NAME = "fire-showcase-assets-v1";

function cacheApiAvailable(): boolean {
  return typeof caches !== "undefined" && typeof caches.open === "function";
}

async function readFromCacheApi(url: string): Promise<ArrayBuffer | null> {
  if (!cacheApiAvailable()) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (!hit) return null;
    const buf = await hit.arrayBuffer();
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

async function writeToCacheApi(url: string, response: Response): Promise<boolean> {
  if (!cacheApiAvailable()) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url, response);
    return true;
  } catch (err) {
    // 配额不足、响应不可克隆等情况忽略（仍可用 IndexedDB 或下次重下），但要把原因打出来便于排查
    console.warn("[showcase] Cache Storage 写入失败:", err);
    return false;
  }
}

/** 换素材（版本号变化）时清掉同一路径的旧条目 */
async function pruneCacheApi(url: string): Promise<void> {
  if (!cacheApiAvailable()) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    const base = url.split("?")[0];
    await Promise.all(keys.filter((req) => req.url.split("?")[0] === base && req.url !== url).map((req) => cache.delete(req)));
  } catch {
    /* 忽略 */
  }
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function readEntry(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function writeEntry(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 清掉旧版本留下的条目（键里带 ?v=，换素材后旧的那份就没用了） */
function pruneOld(db: IDBDatabase, keepKey: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        req.result.forEach((key) => {
          if (typeof key === "string" && key !== keepKey && key.split("?")[0] === keepKey.split("?")[0]) {
            store.delete(key);
          }
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * 读取素材字节流：先查 IndexedDB，没有再走网络；网络结果会静默写入缓存。
 * onProgress 只在网络下载阶段回调（0–1）。
 */
export type AssetCacheMode = "cache-api" | "indexeddb" | "network" | "temporary";

/** 同一个 URL 的下载只跑一次：预取与真正加载共用同一条请求 */
const inflight = new Map<string, Promise<{ buffer: ArrayBuffer; fromCache: boolean; mode: AssetCacheMode }>>();

/** 素材是否已经在本地缓存里（Cache Storage 或 IndexedDB），不发请求 */
export async function isAssetCached(url: string): Promise<boolean> {
  const absUrl = typeof location !== "undefined" ? new URL(url, location.href).href : url;
  if (cacheApiAvailable()) {
    try {
      const cache = await caches.open(CACHE_NAME);
      if (await cache.match(absUrl)) return true;
    } catch { /* 回退到 IndexedDB；仅检查条目，不复制整份模型。 */ }
  }
  const db = await openDb();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).count(absUrl);
      request.onsuccess = () => resolve(request.result > 0);
      request.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}

/**
 * 静默预取：鼠标划过 / 聚焦车型时就先把素材拉下来存进缓存，
 * 真正点选时通常已经就绪，点一下就切过去。
 */
export function prefetchAsset(url: string, onProgress?: (ratio: number) => void): Promise<unknown> {
  return fetchAssetBuffer(url, onProgress);
}

export function fetchAssetBuffer(
  url: string,
  onProgress?: (ratio: number) => void
): Promise<{ buffer: ArrayBuffer; fromCache: boolean; mode: AssetCacheMode }> {
  const absUrl = typeof location !== "undefined" ? new URL(url, location.href).href : url;
  const running = inflight.get(absUrl);
  if (running) {
    running.then(() => onProgress?.(1), () => {});
    return running;
  }
  const task = loadAsset(absUrl, onProgress).finally(() => inflight.delete(absUrl));
  inflight.set(absUrl, task);
  return task;
}

async function loadAsset(
  absUrl: string,
  onProgress?: (ratio: number) => void
): Promise<{ buffer: ArrayBuffer; fromCache: boolean; mode: AssetCacheMode }> {

  // 未保存模型只在当前页面预览，禁止写入 Cache Storage / IndexedDB。
  if (absUrl.startsWith("blob:")) {
    const response = await fetch(absUrl);
    if (!response.ok) throw new Error("临时模型已释放，请重新选择文件");
    const buffer = await response.arrayBuffer();
    onProgress?.(1);
    return { buffer, fromCache: false, mode: "temporary" };
  }

  // 1) HTTPS（线上）：Cache Storage
  const cachedByApi = await readFromCacheApi(absUrl);
  if (cachedByApi) {
    onProgress?.(1);
    return { buffer: cachedByApi, fromCache: true, mode: "cache-api" };
  }

  // 2) 局域网 HTTP：IndexedDB
  const db = await openDb();
  if (db) {
    const hit = await readEntry(db, absUrl);
    if (hit instanceof ArrayBuffer && hit.byteLength > 0) {
      onProgress?.(1);
      return { buffer: hit, fromCache: true, mode: "indexeddb" };
    }
  }

  const res = await fetch(absUrl, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`素材请求失败：${res.status}`);
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const total = Number(res.headers.get("content-length") || 0);
  let buffer: ArrayBuffer;
  if (onProgress && total > 0 && res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        onProgress(Math.min(1, received / total));
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    chunks.forEach((chunk) => {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    });
    buffer = merged.buffer;
  } else {
    buffer = await res.arrayBuffer();
    onProgress?.(1);
  }

  // 缓存写入不能阻塞首帧：大型 GLB 的 Cache Storage / IndexedDB 事务在手机上可能耗时数秒。
  // 直接把下载中的流式响应 put 进 Cache Storage 会报 "network error"（实测 23 MB 的车模必失败）。
  if (buffer.byteLength > 0) {
    void (async () => {
      const cachedByApi = await writeToCacheApi(absUrl, new Response(buffer, {
        headers: { "Content-Type": contentType, "Cache-Control": "max-age=31536000" }
      }));
      if (cachedByApi) await pruneCacheApi(absUrl);
      // HTTPS 手机浏览器避免同时写两份 65–106 MB 车模。
      if (db && !cachedByApi) {
        await writeEntry(db, absUrl, buffer);
        await pruneOld(db, absUrl);
      }
    })();
  }
  return { buffer, fromCache: false, mode: "network" };
}
