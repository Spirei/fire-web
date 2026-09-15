export type HoldingHint = { market: string; code: string; name: string };

/** 去掉链接后仍有字母/汉字才值得送去翻译，避免纯图片或纯 URL 帖让模型编造回复。 */
export function hasTranslatableText(text?: string): boolean {
  const stripped = String(text || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[A-Za-z]{2,}|[\u4e00-\u9fff]{2,}/.test(stripped);
}

export type TextPart =
  | { type: "text"; value: string }
  | { type: "url"; value: string }
  | { type: "mention"; value: string; name: string }
  | { type: "stock"; value: string; market: string; code: string; name: string };

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", quot: '"', lt: "<", gt: ">", apos: "'",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–", hellip: "…"
};

function fromCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

function decodeHtmlEntities(value: string): string {
  let text = value;
  for (let pass = 0; pass < 2; pass += 1) {
    text = text
      .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
      .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => fromCodePoint(parseInt(hex, 16)) ?? match)
      .replace(/&#(\d+);/g, (match, digits: string) => fromCodePoint(Number(digits)) ?? match);
  }
  return text;
}

function stripMarkdownLite(value: string): string {
  return value
    .replace(/^[ \t]*\*[ \t]+/gm, "• ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1");
}

/** 解码 HTML 实体、去掉 Gemini/雪球残留的 markdown，已清洗的文本再跑一遍保持原样。 */
export function normalizeTradingText(value: string): string {
  if (!value) return "";
  return stripMarkdownLite(decodeHtmlEntities(
    value
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const GENERIC_NAMES = new Set([
  "公司", "集团", "科技", "中国", "控股", "股份", "国际", "投资", "银行", "证券",
  "基金", "能源", "医药", "汽车", "地产", "电子", "通信", "网络", "软件", "美国",
  "日本", "香港", "有限", "industry", "holdings", "group", "company", "corp", "inc", "ltd"
]);

export function normalizeCode(code: string, market: string): string {
  let value = code.trim().toUpperCase().replace(/\.(HK|SS|SZ|SH|BJ)$/i, "");
  if (market === "CN") value = value.replace(/^(SH|SZ|BJ)/, "");
  if (market === "HK") {
    value = value.replace(/^HK/, "");
    if (/^\d+$/.test(value)) value = value.padStart(5, "0");
  }
  return value;
}

export function parseSymbolToken(raw: string): { market: string; code: string } | null {
  const token = raw.trim().toUpperCase();
  if (!token || token.length > 16) return null;

  const dotted = token.match(/^([A-Z0-9]+)\.(HK|SS|SZ|SH|BJ)$/);
  if (dotted) {
    const market = dotted[2] === "HK" ? "HK" : "CN";
    return { market, code: normalizeCode(dotted[1], market) };
  }

  const prefixed = token.match(/^(SH|SZ|BJ)(\d{6})$/) || token.match(/^(HK)(\d{4,5})$/);
  if (prefixed) {
    const market = prefixed[1] === "HK" ? "HK" : "CN";
    return { market, code: normalizeCode(prefixed[2], market) };
  }

  if (/^\d{6}$/.test(token)) return { market: "CN", code: token };
  if (/^\d{4,5}$/.test(token)) return { market: "HK", code: token.padStart(5, "0") };
  if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(token)) return { market: "US", code: token };
  return null;
}

export function inferMarket(code: string): string {
  return parseSymbolToken(code)?.market ?? "US";
}

function parseCashTag(inner: string): { market: string; code: string; name: string } | null {
  const wrapped = inner.match(/^(.*?)[(（]([A-Za-z0-9.\-]+)[)）]$/);
  if (wrapped) {
    const parsed = parseSymbolToken(wrapped[2]);
    if (!parsed) return null;
    return { ...parsed, name: wrapped[1].trim() || parsed.code };
  }
  const parsed = parseSymbolToken(inner);
  if (!parsed) return null;
  return { ...parsed, name: parsed.code };
}

function parseStockUrl(raw: string): { market: string; code: string; name: string } | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname;

    const xueqiu = (host === "xueqiu.com" || host.endsWith(".xueqiu.com"))
      ? path.match(/^\/S\/([A-Za-z0-9.\-]+)/i)
      : null;
    if (xueqiu) {
      const parsed = parseSymbolToken(decodeURIComponent(xueqiu[1]));
      return parsed ? { ...parsed, name: parsed.code } : null;
    }

    const yahoo = host === "finance.yahoo.com" || host.endsWith(".finance.yahoo.com")
      ? path.match(/^\/quote\/([^/]+)/i)
      : null;
    if (yahoo) {
      const parsed = parseSymbolToken(decodeURIComponent(yahoo[1]));
      return parsed ? { ...parsed, name: parsed.code } : null;
    }

    if (host === "quote.eastmoney.com") {
      const us = path.match(/^\/us\/([A-Za-z0-9.\-]+)/i);
      if (us) {
        const parsed = parseSymbolToken(us[1].replace(/\.html$/i, ""));
        return parsed ? { ...parsed, name: parsed.code } : null;
      }
      const hk = path.match(/^\/hk\/(\d+)/i);
      if (hk) {
        const parsed = parseSymbolToken(hk[1]);
        return parsed ? { ...parsed, name: parsed.code } : null;
      }
      const cn = path.match(/^\/(sh|sz|bj)(\d{6})/i);
      if (cn) return { market: "CN", code: cn[2], name: cn[2] };
    }
  } catch {
    return null;
  }
  return null;
}

function collectMatches(text: string, holdings: HoldingHint[]): Array<{ start: number; end: number; part: TextPart }> {
  const hits: Array<{ start: number; end: number; part: TextPart }> = [];
  const push = (re: RegExp, toPart: (match: RegExpExecArray) => TextPart | null) => {
    const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = copy.exec(text))) {
      const part = toPart(match);
      if (!part || match[0].length === 0) continue;
      hits.push({ start: match.index, end: match.index + match[0].length, part });
      if (copy.lastIndex === match.index) copy.lastIndex += 1;
    }
  };

  push(/https?:\/\/[^\s<>"'）)\]]+/gi, (match) => {
    const value = match[0].replace(/[.,;:!?。，；：！？]+$/u, "");
    const stock = parseStockUrl(value);
    if (stock) return { type: "stock", value, ...stock };
    return { type: "url", value };
  });

  push(/\$([^$\n]{1,40})\$/g, (match) => {
    const parsed = parseCashTag(match[1].trim());
    if (!parsed) return { type: "text", value: match[0] };
    return { type: "stock", value: match[0], ...parsed };
  });

  push(/\$([A-Z]{2,6}(?:\.[A-Z]{1,2})?)(?![A-Za-z0-9])/g, (match) => {
    const parsed = parseSymbolToken(match[1]);
    if (!parsed) return null;
    return { type: "stock", value: match[0], ...parsed, name: parsed.code };
  });

  push(/(?<![A-Za-z0-9._])@([A-Za-z0-9_\-\u4e00-\u9fff.]{1,32})/g, (match) => ({
    type: "mention",
    value: match[0],
    name: match[1]
  }));

  const unique = new Map<string, HoldingHint>();
  holdings.forEach((item) => {
    const parsed = parseSymbolToken(item.code);
    const market = (parsed?.market || item.market).toUpperCase();
    const code = parsed?.code || item.code.trim().toUpperCase();
    const name = item.name.trim();
    if (code.length >= 2) unique.set(`c:${market}:${code}`, { market, code, name: name || code });
    if (name.length >= 2 && /[\u4e00-\u9fff]/.test(name) && !GENERIC_NAMES.has(name)) unique.set(`n:${name}`, { market, code, name });
    if (name.length >= 4 && /^[A-Za-z]/.test(name) && !GENERIC_NAMES.has(name.toLowerCase())) unique.set(`n:${name.toLowerCase()}`, { market, code, name });
  });

  [...unique.values()]
    .sort((a, b) => Math.max(b.code.length, b.name.length) - Math.max(a.code.length, a.name.length))
    .forEach((item) => {
      const code = item.code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const codeFlags = /[A-Za-z]/.test(item.code) && item.code.length < 4 ? "g" : "gi";
      push(new RegExp(`(?<![A-Za-z0-9.])${code}(?![A-Za-z0-9.])`, codeFlags), (match) => ({
        type: "stock",
        value: match[0],
        market: item.market,
        code: item.code,
        name: item.name
      }));
      if (item.name.length >= 2 && !GENERIC_NAMES.has(item.name) && !GENERIC_NAMES.has(item.name.toLowerCase())) {
        const name = item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // 两个汉字的名字最容易撞进更长的词里（例：「纽约州总检察长和曼哈顿」里的「长和」），
        // 这种两字中文名要求左右至少一侧不是汉字才算提及；雪球原文的 $名称(代码)$ 走上面的
        // cash tag 分支，不受这里影响，仍然可以随意出现在句子中间。
        const bounded = /[\u4e00-\u9fff]/.test(item.name)
          ? (item.name.length === 2 ? `(?<![\\u4e00-\\u9fff])${name}|${name}(?![\\u4e00-\\u9fff])` : name)
          : `\\b${name}\\b`;
        push(new RegExp(bounded, "gi"), (match) => ({
          type: "stock",
          value: match[0],
          market: item.market,
          code: item.code,
          name: item.name
        }));
      }
    });

  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const picked: typeof hits = [];
  let cursor = 0;
  hits.forEach((hit) => {
    if (hit.start < cursor) return;
    const previous = picked[picked.length - 1];
    // 「名称(代码)」相邻写法会同时命中名称与代码两处，这里合并成一个提及，
    // 否则同一只票会在正文里连出两个链接（雪球原文的 $名称(代码)$ 本来就是一个整体，不受影响）。
    if (
      previous && previous.part.type === "stock" && hit.part.type === "stock" &&
      previous.part.market === hit.part.market && previous.part.code === hit.part.code &&
      hit.start - previous.end <= 2
    ) {
      // 顺带吞掉代码后面的右括号，避免渲染成 $长和(00001)$) 这种多余符号。
      const trailing = /[)）]/.test(text[hit.end] ?? "") ? hit.end + 1 : hit.end;
      previous.end = trailing;
      cursor = trailing;
      return;
    }
    picked.push(hit);
    cursor = hit.end;
  });
  return picked;
}

export function splitTradingText(text: string, holdings: HoldingHint[] = []): TextPart[] {
  if (!text) return [];
  const hits = collectMatches(text, holdings);
  const parts: TextPart[] = [];
  let cursor = 0;
  hits.forEach((hit) => {
    if (hit.start > cursor) parts.push({ type: "text", value: text.slice(cursor, hit.start) });
    parts.push(hit.part);
    cursor = hit.end;
  });
  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts;
}
