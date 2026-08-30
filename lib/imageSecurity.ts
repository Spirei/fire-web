/** 图片内容识别与 SVG 消毒。扩展名、MIME 均不可信，最终以文件内容为准。 */

export type SafeImageExt = "jpg" | "png" | "gif" | "webp" | "ico" | "svg";

/** 返回 <!DOCTYPE ...> 结束符后的下标（正确处理内部子集 [...]），未匹配返回 -1。 */
function doctypeEnd(text: string): number {
  if (!/^<!doctype/i.test(text)) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ">" && depth === 0) return i + 1;
  }
  return -1;
}

/** 移除文本中的每个 <!DOCTYPE ...>（跨内部子集），保留其它内容。 */
function stripDoctypeStr(text: string): string {
  let idx = text.toLowerCase().indexOf("<!doctype");
  while (idx >= 0) {
    const end = doctypeEnd(text.slice(idx));
    if (end < 0) break;
    text = text.slice(0, idx) + text.slice(idx + end);
    idx = text.toLowerCase().indexOf("<!doctype");
  }
  return text;
}

/**
 * 取得 SVG 的真实根节点。
 *
 * TradingView 等站点导出的 SVG 常在根节点前放置版权注释，例如：
 * `<!-- by TradingView --><svg ...>`。这些注释不影响图片格式，也不应被
 * 当成“伪装扩展名”。这里只跳过 BOM、空白、XML 声明和完整 XML 注释，
 * 其他前导内容（HTML、任意处理指令、未闭合注释）仍会导致识别失败。
 */
function getSvgRootText(buffer: Buffer): string | null {
  let text = buffer.toString("utf8").replace(/^\uFEFF/, "");

  while (true) {
    text = text.trimStart();

    if (text.startsWith("<!--")) {
      const commentEnd = text.indexOf("-->", 4);
      if (commentEnd < 0) return null;
      text = text.slice(commentEnd + 3);
      continue;
    }

    // 只接受真正的 XML 声明，不放行 <?xml-stylesheet?> 等处理指令。
    if (/^<\?xml(?:\s|\?>)/i.test(text)) {
      const declarationEnd = text.indexOf("?>", 5);
      if (declarationEnd < 0) return null;
      text = text.slice(declarationEnd + 2);
      continue;
    }

    // 跳过 DOCTYPE（无害声明，不加载外部资源）。
    if (/^<!doctype/i.test(text)) {
      const end = doctypeEnd(text);
      if (end < 0) return null;
      text = text.slice(end);
      continue;
    }

    break;
  }

  return text;
}

export function sniffImageExt(buffer: Buffer): SafeImageExt | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.length >= 6) {
    const gif = buffer.toString("ascii", 0, 6);
    if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) return "ico";
  const svgRoot = getSvgRootText(buffer);
  if (svgRoot && /^<svg(?:\s|>)/i.test(svgRoot)) return "svg";
  return null;
}

/**
 * 拒绝脚本、事件、外部资源与可触发执行/网络访问的 SVG 内容。
 *
 * 注意：不能直接禁止 `http://` / `https://`，因为规范 SVG 通常包含
 * `xmlns="http://www.w3.org/2000/svg"`。这里仅检查真正能加载资源的属性，
 * 并允许 `<use href="#local-symbol">` 这类文件内引用。
 */
export function isSafeSvg(buffer: Buffer): boolean {
  if (sniffImageExt(buffer) !== "svg") return false;
  // 先剥离 DOCTYPE（无害），避免误伤 Apple CoreSVG 等含 DTD 导出的文件。
  const text = stripDoctypeStr(buffer.toString("utf8")).toLowerCase();
  const dangerousMarkup = [
    "<script", "<foreignobject", "<object", "<embed", "<iframe", "<link", "<meta", "<a ",
    "<image", "<animate", "<set", "<animatetransform", "<!doctype", "<?xml-stylesheet",
    "onerror", "onload", "onclick", "onmouse", "onfocus", "onblur", "onchange", "onsubmit", "onkey",
    "onpointer", "onauxclick", "ondrag", "ondrop", "onwheel", "oncopy", "onpaste", "oncut", "oninput",
    "onselect", "javascript:", "vbscript:"
  ];
  if (dangerousMarkup.some((item) => text.includes(item))) return false;

  // style 标签/属性可用于正常图标；url(#id) 是渐变、裁切、滤镜的标准本地引用。
  if (/\b(?:@import\b|expression\s*\(|-moz-binding\b)/i.test(text)) return false;
  const cssUrlPattern = /url\s*\(\s*(["']?)(.*?)\1\s*\)/gi;
  for (const match of text.matchAll(cssUrlPattern)) {
    const value = match[2].trim();
    if (!value.startsWith("#") || value.length < 2) return false;
  }

  // href / xlink:href 只允许引用当前 SVG 内的 id，禁止远程、data: 与相对文件资源。
  const hrefPattern = /\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi;
  for (const match of text.matchAll(hrefPattern)) {
    const value = match[2].trim();
    if (!value.startsWith("#") || value.length < 2) return false;
  }

  // 其他常见资源属性一律不得出现；xmlns 命名空间声明不在此列。
  if (/\b(?:src|poster)\s*=\s*["']/i.test(text)) return false;
  return true;
}

export function validateImageContent(buffer: Buffer, declaredExt: string): SafeImageExt | null {
  const actual = sniffImageExt(buffer);
  const declared = declaredExt.toLowerCase() === "jpeg" ? "jpg" : declaredExt.toLowerCase();
  if (!actual || actual !== declared) return null;
  if (actual === "svg" && !isSafeSvg(buffer)) return null;
  return actual;
}

/**
 * 上传通过安全校验后，将 TradingView 导出文件的来源注释规范为本站标识。
 * 仅替换 XML 注释，不触碰 path、颜色、渐变等任何图形内容。
 */
export function normalizeSvgAttribution(buffer: Buffer): Buffer {
  const text = buffer.toString("utf8");
  const normalized = text.replace(/<!--\s*by\s+tradingview\s*-->/gi, "<!-- by fire -->");
  return normalized === text ? buffer : Buffer.from(normalized, "utf8");
}

/** 本站 SVG 签名注释。 */
export const SVG_SIGNATURE = "<!-- by fire -->";

/**
 * 清洗 SVG：去掉 XML 声明、DOCTYPE 与 `<svg>` 之前的前导内容，
 * 并把它们变为本站签名注释，得到 `<!-- by fire -->\n<svg>…</svg>`。
 */
export function sanitizeSvg(buffer: Buffer): Buffer {
  let text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  text = text.replace(/<\?xml[^>]*\?>/gi, "");
  text = stripDoctypeStr(text);
  const root = text.search(/<svg(?:\s|>)/i);
  const body = root < 0 ? text.trim() : text.slice(root).trim();
  if (!body) return buffer;
  return Buffer.from(`${SVG_SIGNATURE}\n${body}`, "utf8");
}
