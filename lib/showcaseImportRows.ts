import fs from "fs";
import path from "path";
import { SHOWCASE_MODELS } from "@/components/showcase/presets/models";
import { MODELS_DIR, modelFileExists, modelPreviewExists, modelUrlExists, orderRanker, readRegistry, readStoredModels, resolveOrder, validModelFile } from "@/lib/showcaseModels";

function sourceBytes(file: string, builtin = false): number | undefined {
  if (!validModelFile(file)) return undefined;
  const fullPath = builtin ? path.join(process.cwd(), "public", "mclaren", file) : path.join(MODELS_DIR, file);
  try {
    const stat = fs.statSync(fullPath);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/** 导入页与流程页共用同一份服务端车型清单和排序。 */
export function getShowcaseImportRows() {
  const { order, builtinMeta, hiddenIds } = readRegistry();
  const builtin = SHOWCASE_MODELS.map((item) => {
    const cover = builtinMeta[item.id]?.cover ?? "";
    const file = item.config.assets.model.split("?")[0].split("/").pop() ?? item.config.assets.model;
    return {
      id: item.id,
      label: item.label,
      note: item.note,
      file,
      sourceBytes: sourceBytes(file, true),
      cover: cover && modelUrlExists(cover) ? cover : "",
      params: {
        ...item.config.model,
        wheelPattern: typeof item.config.model?.wheelPattern === "string" ? item.config.model.wheelPattern : undefined,
        materialRules: (item.config.model?.materialRules ?? []).map((rule) => ({
          match: typeof rule.match === "string" ? rule.match : String(rule.match),
          metalness: rule.metalness,
          roughness: rule.roughness
        }))
      },
      updatedAt: "",
      present: modelUrlExists(item.config.assets.model),
      previewReady: Boolean(item.config.assets.previewModel && modelUrlExists(item.config.assets.previewModel)),
      hidden: hiddenIds.includes(item.id),
      builtin: true
    };
  });
  const stored = readStoredModels();
  const existing = [
    ...builtin,
    ...stored.map((model) => ({
      id: model.id,
      label: model.label,
      note: model.note,
      file: model.file,
      sourceBytes: sourceBytes(model.file),
      cover: model.cover ?? "",
      params: model.params,
      updatedAt: model.updatedAt,
      present: modelFileExists(model.file),
      previewReady: modelPreviewExists(model.file),
      hidden: hiddenIds.includes(model.id),
      builtin: false
    }))
  ];
  const rank = orderRanker(resolveOrder(order, stored.map((model) => model.id)));
  return existing.sort((a, b) => rank(a.id) - rank(b.id));
}
