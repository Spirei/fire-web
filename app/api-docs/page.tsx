import ApiDocsClient from "./ApiDocsClient";
import { readApiDocument } from "@/lib/apiDocs";
import { parseApiDocsVersion } from "@/lib/apiDocsVersion";
export const dynamic = "force-dynamic";
export default async function ApiDocsPage({ searchParams }: { searchParams: Promise<{ version?: string | string[] }> }) {
  const version = parseApiDocsVersion((await searchParams).version) ?? 1;
  try { return <ApiDocsClient initialDocument={readApiDocument(version)} />; }
  catch { return <ApiDocsClient initialDocument={{ version, content: "", revision: "", error: "读取文档失败，请重试" }} />; }
}
