export type ApiDocsVersion = 1 | 2;
export const API_DOCS = {
  1: { label: "v1", file: "api-spec.md", description: "Web 与兼容接口" },
  2: { label: "v2", file: "api-spec-v2.md", description: "App 专用接口" }
} as const;
export function parseApiDocsVersion(value: unknown): ApiDocsVersion | null {
  if (value == null || value === "1" || value === "v1") return 1;
  return value === "2" || value === "v2" ? 2 : null;
}
export interface ApiDocument {
  version: ApiDocsVersion;
  content: string;
  revision: string;
  error?: string;
}
