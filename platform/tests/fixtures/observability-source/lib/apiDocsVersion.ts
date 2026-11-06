export const API_DOCS = {
  1: { file: "api-spec.md", description: "Web 与兼容接口" },
  2: { file: "api-spec-v2.md", description: "App 专用接口" }
} as const;
export type ApiDocsVersion = keyof typeof API_DOCS;
export const API_DOCS_VERSIONS = Object.keys(API_DOCS).map(Number).sort((a, b) => a - b) as ApiDocsVersion[];
export function parseApiDocsVersion(value: unknown): ApiDocsVersion | null {
  if (value == null) return API_DOCS_VERSIONS[0];
  if (typeof value !== "string" || !/^v?[1-9]\d*$/.test(value)) return null;
  const version = Number(value.replace(/^v/, ""));
  return Number.isSafeInteger(version) && Object.hasOwn(API_DOCS, version) ? version as ApiDocsVersion : null;
}
export interface ApiDocument {
  version: ApiDocsVersion;
  content: string;
  revision: string;
  error?: string;
}
