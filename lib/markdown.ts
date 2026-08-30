/* ---------- 轻量 Markdown 渲染（仅用于 API 规范文档等自控内容） ----------
 * 支持：标题 / 表格 / 代码块 / 列表 / 引用 / 粗体 / 行内代码 / 链接。
 * 所有内容先转义再套标签，防 XSS；链接仅允许相对路径与 https/http。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(s: string): string {
  let out = escapeHtml(s);
  // 行内代码
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    // 方法 + 路径（如 `GET /api/v1/quotes`）是接口说明，不做行内复制提示；
    // 独立 API 路径、完整 URL 与 Bearer Token 仍保留复制能力。
    const copyable = /^\/api(?:\/|$)|^https?:\/\/|^Authorization:\s*Bearer/i.test(code.trim());
    return copyable
      ? `<code class="markdown-inline-copy" data-copy-inline="true" role="button" tabindex="0" title="点击复制">${code}</code>`
      : `<code>${code}</code>`;
  });
  // 粗体
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 链接
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
    if (/^(https?:\/\/|\/)/.test(href)) {
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return text;
  });
  return out;
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let inCode = false;
  const codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  const openList = (t: "ul" | "ol") => {
    if (listType !== t) {
      closeList();
      listType = t;
      html.push(`<${t}>`);
    }
  };

  const codeBlock = (code: string) => `<pre><button type="button" class="markdown-copy-button" data-copy-code="true" aria-label="复制代码" title="复制代码"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button><code>${code}</code></pre>`;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCode) {
        html.push(codeBlock(codeBuf.join("\n")));
        codeBuf.length = 0;
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      i += 1;
      continue;
    }
    if (inCode) {
      codeBuf.push(escapeHtml(line));
      i += 1;
      continue;
    }

    // 表格
    if (trimmed.startsWith("|") && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const header = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        body.push(lines[i].trim().split("|").slice(1, -1).map((c) => c.trim()));
        i += 1;
      }
      let table = `<div class="markdown-table-wrap"><table><thead><tr>`;
      header.forEach((h) => {
        table += `<th>${inline(h)}</th>`;
      });
      table += "</tr></thead><tbody>";
      body.forEach((row) => {
        table += "<tr>";
        row.forEach((cell) => {
          table += `<td>${inline(cell)}</td>`;
        });
        table += "</tr>";
      });
      table += "</tbody></table></div>";
      html.push(table);
      continue;
    }

    if (trimmed === "") {
      closeList();
      i += 1;
      continue;
    }
    if (/^#{1,3}\s/.test(trimmed)) {
      closeList();
      const level = trimmed.match(/^#+/)?.[0].length ?? 1;
      const title = trimmed.replace(/^#+\s*/, "");
      const slug =
        title
          .toLowerCase()
          .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || `sec-${level}-${i}`;
      const subsection = level === 2 && /^\d+\.\d+\b/.test(title);
      html.push(`<h${level}${subsection ? ' class="markdown-subsection"' : ""} id="${slug}">${inline(title)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      closeList();
      const quote = trimmed.replace(/^>\s?/, "");
      html.push(`<blockquote>${inline(quote)}</blockquote>`);
      i += 1;
      continue;
    }
    if (/^[-*]\s/.test(trimmed)) {
      openList("ul");
      html.push(`<li>${inline(trimmed.replace(/^[-*]\s/, ""))}</li>`);
      i += 1;
      continue;
    }
    if (/^\d+\.\s/.test(trimmed)) {
      openList("ol");
      html.push(`<li>${inline(trimmed.replace(/^\d+\.\s/, ""))}</li>`);
      i += 1;
      continue;
    }
    closeList();
    html.push(`<p>${inline(trimmed)}</p>`);
    i += 1;
  }
  if (inCode) {
    html.push(codeBlock(codeBuf.join("\n")));
  }
  closeList();
  return html.join("\n");
}
