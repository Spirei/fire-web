import { parseAssistantBlocks, parseInlineSegments } from "@/lib/assistantMarkdown";

/**
 * 助手回答的富文本渲染：把 lib/assistantMarkdown 解析出的块映射成 JSX。
 * 单独成文件是为了脱离 ContextAssistant（大客户端组件）也能被回归测试直接渲染断言。
 */
function inlineText(text: string) {
  return parseInlineSegments(text).map((segment, index) => {
    if (segment.type === "code") return <code key={index} className="rounded bg-black/[.055] px-1 py-0.5 font-mono text-[.88em]">{segment.text}</code>;
    if (segment.type === "strong") return <strong key={index} className="font-semibold text-ink">{segment.text}</strong>;
    if (segment.type === "link") return <a key={index} href={segment.href} target="_blank" rel="noreferrer noopener" className={segment.text.startsWith("http") ? "assistant-inline-link break-all" : "assistant-inline-link"}>{segment.text}</a>;
    return <span key={index}>{segment.text}</span>;
  });
}

function displayTable(rows: string[][], key: number) {
  const [head, ...body] = rows;
  return <div key={key} className="assistant-md-table-wrap"><table className="assistant-md-table"><thead><tr>{head.map((cell, index) => <th key={index}>{inlineText(cell)}</th>)}</tr></thead><tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{head.map((_, columnIndex) => <td key={columnIndex}>{inlineText(row[columnIndex] ?? "")}</td>)}</tr>)}</tbody></table></div>;
}

export default function AssistantRichText({ text }: { text: string }) {
  return <div className="space-y-1.5">{parseAssistantBlocks(text).map((block, index) => {
    if (block.type === "blank") return <div key={index} className="h-1" />;
    if (block.type === "divider") return <div key={index} className="my-2 h-px bg-black/[.08] dark:bg-white/[.12]" />;
    if (block.type === "heading") return <div key={index} className="pt-1 font-semibold text-ink">{inlineText(block.text)}</div>;
    if (block.type === "quote") return <div key={index} className="border-l-2 border-black/[.12] pl-3 text-muted dark:border-white/[.16]">{inlineText(block.text)}</div>;
    if (block.type === "bullet") return <div key={index} className="flex gap-2"><span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[#6c9f98]" /><span className="min-w-0">{inlineText(block.text)}</span></div>;
    if (block.type === "numbered") return <div key={index} className="flex gap-2"><span className="min-w-4 shrink-0 font-medium text-muted">{block.marker}.</span><span className="min-w-0">{inlineText(block.text)}</span></div>;
    if (block.type === "table") return displayTable(block.rows, index);
    return <div key={index}>{inlineText(block.text)}</div>;
  })}</div>;
}
