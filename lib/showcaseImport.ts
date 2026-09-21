import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { MODELS_DIR, ensureRegistry, sanitizeParams, validModelFile, writeStoredModels, type StoredShowcaseModel } from "./showcaseModels";
import { SHOWCASE_MODELS } from "@/components/showcase/presets/models";
import { validateWorkbench } from "@/components/showcase/workbenchUtils";

/** 上传附件只在参数和登记表都保存成功后保留；任何写入失败都会回收新文件。 */
export function commitShowcaseImport(tempFile: string, rawName: string, input: {
  id: string; label: string; note: string; params: StoredShowcaseModel["params"];
}) {
  const error = validateWorkbench(input, input.params);
  if (error) throw new Error(error);
  if (!validModelFile(rawName)) throw new Error("素材文件名不合法");
  const models = ensureRegistry();
  if ([...models, ...SHOWCASE_MODELS].some(model => model.id === input.id)) throw new Error("车型代号已存在，请修改代号后重试");
  const stem = rawName.replace(/\.glb$/i, "").slice(0, 70).replace(/^\.+/, "") || "model";
  const file = `${stem}-${randomUUID().slice(0, 8)}.glb`;
  const dest = path.join(MODELS_DIR, file);
  const now = new Date().toISOString();
  const entry: StoredShowcaseModel = { id: input.id, label: input.label.trim(), note: input.note.trim(), file, params: sanitizeParams(input.params), createdAt: now, updatedAt: now };
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  let copied = false;
  try {
    fs.copyFileSync(tempFile, dest, fs.constants.COPYFILE_EXCL);
    copied = true;
    writeStoredModels([...models, entry]);
    return entry;
  } catch (error) {
    if (copied) fs.rmSync(dest, { force: true });
    throw error;
  }
}
