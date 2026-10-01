import { getDb } from "./db";
import { hmacWithDataKey } from "./secretStorage";

/** Fingerprint encrypted rows, so neither the revision nor its input exposes a key. */
export function modelSettingsRevision() {
  const rows = getDb().prepare("SELECT key, value FROM site_settings WHERE key IN ('modelServices', 'llmProvider', 'llmApiUrl', 'llmModel', 'llmApiKey', 'deepseekApiUrl', 'deepseekModel', 'deepseekApiKey') ORDER BY key").all();
  return hmacWithDataKey(JSON.stringify(rows));
}

export class ModelSettingsConflictError extends Error {
  constructor() { super("模型配置已在其他页面更新，请刷新后重新编辑；本次修改未保存"); }
}
