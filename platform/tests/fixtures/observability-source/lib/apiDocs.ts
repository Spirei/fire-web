import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { API_DOCS, type ApiDocsVersion } from "./apiDocsVersion";
export const API_DOCS_MAX_BYTES = 512 * 1024;
const fileFor = (version: ApiDocsVersion) => path.join(process.cwd(), "docs", API_DOCS[version].file);
const revisionOf = (content: string) => createHash("sha256").update(content).digest("hex");
export function readApiDocument(version: ApiDocsVersion) {
  const content = fs.readFileSync(fileFor(version), "utf8");
  return { version, content, revision: revisionOf(content), path: `docs/${API_DOCS[version].file}` };
}
export function saveApiDocument(version: ApiDocsVersion, content: string, expectedRevision?: string) {
  const file = fileFor(version);
  if (expectedRevision !== undefined && readApiDocument(version).revision !== expectedRevision) return null;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { saved: true, version, bytes: Buffer.byteLength(content, "utf8"), revision: revisionOf(content) };
}
