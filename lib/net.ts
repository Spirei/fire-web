/* ---------- 出站代理工具 ----------
 *
 * 国外数据源（SEC EDGAR、Dataroma、Wikipedia 等）在部分网络环境无法直连，
 * 可经 本地代理 等本地代理访问：
 *  - 默认代理：http://127.0.0.1:7890（本地代理 macOS 代理共享默认端口）
 *  - 环境变量覆盖：STOCKLOG_PROXY=http://127.0.0.1:7890 或 socks5://127.0.0.1:7890
 *  - 设 STOCKLOG_PROXY=off 可彻底关闭代理（全部直连）
 * 代理端口探测结果缓存 60 秒：代理未开启时自动直连，无需重启服务；
 * 代理请求失败时也会自动回退直连，保证数据源任何情况下都不阻塞页面。
 */

import net from "node:net";
import { ProxyAgent } from "undici";

const DEFAULT_PROXY = "http://127.0.0.1:7890";
const PROBE_TTL_OK = 60 * 1000;
const PROBE_TTL_FAIL = 10 * 1000;

interface ProxyDecision {
  ok: boolean;
  at: number;
}

let decision: ProxyDecision | null = null;
let agent: ProxyAgent | null = null;

export function proxyConfig(): { url: string; enabled: boolean } {
  const env = process.env.STOCKLOG_PROXY?.trim() ?? "";
  if (env === "off" || env === "0" || env === "false") return { url: "", enabled: false };
  return { url: env || DEFAULT_PROXY, enabled: true };
}

function parseProxyUrl(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "socks5:") return null;
    const port = Number(u.port || (u.protocol === "socks5:" ? 1080 : 8080));
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

function canReachProxy(url: string): Promise<boolean> {
  const parsed = parseProxyUrl(url);
  if (!parsed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = net.connect({ host: parsed.host, port: parsed.port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1500);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function getAgent(url: string): ProxyAgent {
  if (!agent) {
    agent = new ProxyAgent({
      uri: url,
      connectTimeout: 2000
    });
  }
  return agent;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FetchWithDispatcher = {
  (input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }): Promise<Response>;
};
const fetchImpl = fetch as FetchFn as FetchWithDispatcher;

/**
 * 优先走代理的 fetch：代理可达则用代理，否则（或代理请求失败）直连。
 * 与全局 fetch 签名一致，可平替任何服务端数据源请求。
 */
export async function proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const cfg = proxyConfig();
  if (cfg.enabled) {
    const ttl = decision?.ok ? PROBE_TTL_OK : PROBE_TTL_FAIL;
    if (!decision || Date.now() - decision.at > ttl) {
      // 代理首次探测可能因节点预热失败，重试 3 次
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        ok = await canReachProxy(cfg.url);
        if (!ok && i < 2) await new Promise((r) => setTimeout(r, 800));
      }
      decision = { ok, at: Date.now() };
    }
    if (decision.ok) {
      try {
        return await fetchImpl(input, { ...init, dispatcher: getAgent(cfg.url) });
      } catch {
        /* 代理请求失败 → 回退直连 */
      }
    }
  }
  return fetch(input, init);
}
