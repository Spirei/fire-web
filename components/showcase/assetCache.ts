/**
 * 首页 3D 素材的持久化缓存。
 *
 * 背景：车模约 20 MB，浏览器 HTTP 缓存并不保证留住它（实测加了 immutable 之后刷新仍是整包重下），
 * 局域网 HTTP 访问又拿不到 Cache API（它要求安全上下文），所以这里用 IndexedDB 自己存字节流：
 * 首次访问下载并写入，之后刷新直接命中，不再走网络；读取失败一律回退成普通请求，不影响加载。
 */

const DB_NAME = "fire-showcase-assets";
const STORE = "files";
const DB_VERSION = 1;

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
export async function fetchAssetBuffer(
  url: string,
  onProgress?: (ratio: number) => void
): Promise<{ buffer: ArrayBuffer; fromCache: boolean }> {
  const db = await openDb();
  if (db) {
    const hit = await readEntry(db, url);
    if (hit instanceof ArrayBuffer && hit.byteLength > 0) {
      onProgress?.(1);
      return { buffer: hit, fromCache: true };
    }
  }

  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`素材请求失败：${res.status}`);
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

  if (db && buffer.byteLength > 0) {
    await writeEntry(db, url, buffer);
    await pruneOld(db, url);
  }
  return { buffer, fromCache: false };
}
