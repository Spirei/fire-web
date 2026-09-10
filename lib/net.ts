/* ---------- 出站代理工具 ----------
 *
 * 国外数据源（SEC EDGAR、Dataroma、Wikipedia 等）在部分网络环境无法直连，
 * 可经 HTTP / SOCKS5 代理访问：
 *  - 默认关闭，避免把开发者本机代理带入服务器或公开部署
 *  - 通过环境变量启用：STOCKLOG_PROXY=http://proxy-host:8080
 *  - 设 STOCKLOG_PROXY=off 可显式关闭代理（全部直连）
 * 代理端口探测结果缓存 60 秒：代理未开启时自动直连，无需重启服务；
 * 代理请求失败时也会自动回退直连，保证数据源任何情况下都不阻塞页面。
 */

import net from "node:net";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const PROBE_TTL_OK = 60 * 1000;
const PROBE_TTL_FAIL = 10 * 1000;

interface ProxyDecision {
  ok: boolean;
  at: number;
}

let decision: ProxyDecision | null = null;
let agent: ProxyAgent | null = null;

/** 排查用开关：STOCKLOG_PROXY_DEBUG=1 时打印每条请求走代理还是直连（默认静默） */
function proxyDebug(): boolean {
    const flag = process.env.STOCKLOG_PROXY_DEBUG?.trim().toLowerCase();
    return flag === "1" || flag === "true";
}

export function proxyConfig(): { url: string; enabled: boolean } {
  const env = process.env.STOCKLOG_PROXY?.trim() ?? "";
  if (!env || env === "off" || env === "0" || env === "false") return { url: "", enabled: false };
  return { url: env, enabled: true };
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

/* ---------- no_proxy：内网 / 回环地址永不发往代理 ----------
 *
 * 代理是「出站访问境外源」用的，内网地址（富途 OpenD、NAS 接口、体检探针等）必须直连：
 * 一来把内网主机名/IP 交给第三方代理等于泄露内网拓扑，二来代理可能根本回不到内网。
 * 判定顺序：NO_PROXY / no_proxy 环境变量（支持 `*`、域名后缀、IPv4 与 IPv4/掩码）
 *  → 内置私网 / 回环 / 链路本地 / CGNAT 段。命中即直连，不看代理是否可用。
 */
function ipv4ToInt(ip: string): number | null {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        const n = Number(part);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        value = value * 256 + n;
    }
    return value;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
    const [network, bitsRaw] = cidr.split("/");
    const bits = Number(bitsRaw);
    const ipInt = ipv4ToInt(ip);
    const netInt = ipv4ToInt(network);
    if (ipInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) >>> 0 === (netInt & mask) >>> 0;
}

/** 内置私网 / 回环 / 本机域名判断（不依赖环境变量，保证任何部署下都不外发内网请求） */
export function isPrivateHost(hostRaw: string): boolean {
    const host = hostRaw.trim().toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) return false;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal")) return true;
    // IPv6 回环 / 唯一本地地址 / 链路本地
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
    const ip = ipv4ToInt(host);
    if (ip === null) return false;
    const first = ip >>> 24;
    const second = (ip >>> 16) & 0xff;
    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 169 && second === 254) return true;
    if (first === 100 && second >= 64 && second <= 127) return true; // CGNAT
    return false;
}

/** NO_PROXY / no_proxy 命中的目标也直连（常见写法：localhost,127.0.0.1,.internal,192.168.0.0/16,*） */
function matchesNoProxyEnv(hostRaw: string): boolean {
    const raw = process.env.NO_PROXY || process.env.no_proxy || "";
    const host = hostRaw.trim().toLowerCase().replace(/^\[|\]$/g, "");
    if (!raw.trim() || !host) return false;
    return raw.split(",").map((rule) => rule.trim().toLowerCase()).filter(Boolean).some((rule) => {
        if (rule === "*") return true;
        const entry = rule.includes("/") ? rule : rule.split(":")[0];
        if (!entry) return false;
        if (entry.includes("/")) return ipv4InCidr(host, entry);
        const bare = entry.startsWith(".") ? entry.slice(1) : entry;
        return host === bare || host.endsWith(`.${bare}`);
    });
}

function bypassProxy(input: RequestInfo | URL): boolean {
    let host = "";
    try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
        host = new URL(url).hostname;
    } catch {
        return false;
    }
    return isPrivateHost(host) || matchesNoProxyEnv(host);
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

/**
 * Node 自带的 fetch 与这里安装的 undici 包不是同一份实现：把 undici 包创建的
 * ProxyAgent 当 dispatcher 传给全局 fetch 会报 `invalid onRequestStart method
 * (UND_ERR_INVALID_ARG)`，代理请求永远失败并静默回退直连（线上表现就是「配了代理
 * 也没用、Yahoo 扩展行情仍然取不到」）。因此代理分支必须用 undici 包自己的 fetch，
 * 与 ProxyAgent 配套；未启用代理或代理失败时仍回退全局 fetch 直连。
 */
type UndiciFetchFn = (input: string | URL, init?: Record<string, unknown>) => Promise<unknown>;
const fetchWithProxy = undiciFetch as unknown as UndiciFetchFn;

/**
 * 优先走代理的 fetch：代理可达则用代理，否则（或代理请求失败）直连。
 * 与全局 fetch 签名一致，可平替任何服务端数据源请求。
 */
export async function proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // 内网 / 回环 / NO_PROXY 命中：直接直连，绝不把内网地址交给代理
    if (bypassProxy(input)) {
        if (proxyDebug()) console.log(`[proxyFetch] 直连（内网 / NO_PROXY） ${String(input).slice(0, 120)}`);
        return fetch(input, init);
    }
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
                if (proxyDebug()) console.log(`[proxyFetch] 走代理 ${cfg.url} ${String(input).slice(0, 120)}`);
                return (await fetchWithProxy(String(input), {
                    ...(init as Record<string, unknown>),
                    dispatcher: getAgent(cfg.url)
                })) as Response;
            } catch {
                /* 代理请求失败 → 回退直连 */
                if (proxyDebug()) console.log(`[proxyFetch] 代理失败，回退直连 ${String(input).slice(0, 120)}`);
            }
        }
    }
    return fetch(input, init);
}
