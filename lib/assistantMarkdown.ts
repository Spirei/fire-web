/**
 * 助手回答的轻量 Markdown 解析（纯函数，便于回归测试）。
 *
 * 大模型回答里最常见的排版是「结论 + 短列表 + 数字表格」。此前渲染层只认标题、列表和粗体：
 * 表格会整段以裸竖线显示、链接不可点，读起来很费劲。这里补上表格、链接、引用块与分隔线，
 * 并把解析与渲染分开，渲染层只负责把这些块映射成 JSX。
 */

export type AssistantBlock =
  | { type: "blank" }
  | { type: "heading"; text: string }
  | { type: "divider" }
  | { type: "quote"; text: string }
  | { type: "bullet"; text: string }
  | { type: "numbered"; marker: string; text: string }
  | { type: "table"; rows: string[][] }
  | { type: "text"; text: string };

export type InlineSegment =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "link"; text: string; href: string };

/** 只放行 http/https，避免模型输出 javascript:、data: 一类协议被点成可执行链接。 */
export function safeLinkTarget(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

export function parseInlineSegments(text: string): InlineSegment[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^()\s]+\)|https?:\/\/[^\s<>()（）「」，。；]+)/g).filter(Boolean);
  return parts.map((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return { type: "code", text: part.slice(1, -1) } as const;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return { type: "strong", text: part.slice(2, -2) } as const;
    const markdownLink = part.match(/^\[([^\]\n]+)\]\(([^()\s]+)\)$/);
    if (markdownLink) {
      const href = safeLinkTarget(markdownLink[2]);
      return href ? ({ type: "link", text: markdownLink[1], href } as const) : ({ type: "text", text: markdownLink[1] } as const);
    }
    const href = safeLinkTarget(part);
    if (href) return { type: "link", text: part, href } as const;
    return { type: "text", text: part } as const;
  });
}

function splitTableRow(line: string) {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableRow(line: string) {
  return line.startsWith("|") && line.endsWith("|") && line.length > 2;
}

function isTableDivider(line: string) {
  return line.includes("-") && /^\|?[\s:|-]*-[\s:|-]*\|?$/.test(line);
}

export function parseAssistantBlocks(text: string): AssistantBlock[] {
  const lines = text.split("\n");
  const blocks: AssistantBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    // 表格：一行表头 + 一行 |---|---| 分隔线，之后连续的行都算表格体。
    if (isTableRow(line) && index + 1 < lines.length && isTableDivider(lines[index + 1].trim())) {
      const rows = [splitTableRow(line)];
      index += 2;
      while (index < lines.length && isTableRow(lines[index].trim())) {
        rows.push(splitTableRow(lines[index].trim()));
        index += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }
    if (!line) blocks.push({ type: "blank" });
    else if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) blocks.push({ type: "divider" });
    else {
      const heading = line.match(/^#{1,3}\s+(.+)$/);
      const quote = line.match(/^>\s?(.*)$/);
      const bullet = line.match(/^[-*•]\s+(.+)$/);
      const numbered = line.match(/^(\d+)[.、]\s*(.+)$/);
      if (heading) blocks.push({ type: "heading", text: heading[1] });
      else if (quote) blocks.push({ type: "quote", text: quote[1] });
      else if (bullet) blocks.push({ type: "bullet", text: bullet[1] });
      else if (numbered) blocks.push({ type: "numbered", marker: numbered[1], text: numbered[2] });
      else blocks.push({ type: "text", text: line });
    }
    index += 1;
  }
  return blocks;
}
