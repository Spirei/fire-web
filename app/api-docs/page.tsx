import ApiDocsClient from "./ApiDocsClient";
import { platformJson } from "@/lib/platformTransport";
import { cookies } from "next/headers";
import { parseApiDocsVersion } from "@/lib/apiDocsVersion";
import type { ApiDocument } from "@/lib/apiDocsVersion";
export const dynamic = "force-dynamic";
export default async function ApiDocsPage({
  searchParams,
}: {
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const version = parseApiDocsVersion((await searchParams).version) ?? 1;
  try {
    const result = await platformJson<{ code: number; data: ApiDocument }>(
      `/api/api-docs?version=${version}`,
      { cookie: (await cookies()).toString(), accept: "application/json" },
    );
    if (
      result.code !== 0 ||
      result.data?.version !== version ||
      typeof result.data.content !== "string"
    )
      throw new Error("document unavailable");
    return <ApiDocsClient initialDocument={result.data} />;
  } catch {
    return (
      <ApiDocsClient
        initialDocument={{
          version,
          content: "",
          revision: "",
          error: "读取文档失败，请重试",
        }}
      />
    );
  }
}
