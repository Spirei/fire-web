import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export function confirmRevision(expected, current) {
  if (
    !/^[a-f0-9]{40}$/.test(current) ||
    (expected && (!/^[a-f0-9]{40}$/.test(expected) || expected !== current))
  )
    throw new Error("main 已变化，请重新确认构建目标");
}
export function releaseIdentity(root, repository, revision) {
  confirmRevision("", revision);
  const version = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  if (
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)
  )
    throw new Error("发布身份无效");
  const directory = path.join(root, "platform/migrations");
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (!files.length) throw new Error("迁移清单为空");
  const hash = createHash("sha256");
  for (const name of files)
    hash
      .update(name + "\0")
      .update(readFileSync(path.join(directory, name)))
      .update("\0");
  return {
    version,
    revision,
    schema_hash: hash.digest("hex"),
    image: "ghcr.io/" + repository.toLowerCase(),
  };
}
export async function findPublishedRelease(api, expected) {
  for (let page = 1; page <= 20; page++) {
    const records = await api(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(records)) throw new Error("发布记录不完整");
    for (const record of records) {
      if (!record || typeof record !== "object")
        throw new Error("发布记录无效");
      if (
        record.draft ||
        record.prerelease ||
        record.target_commitish !== expected.revision
      )
        continue;
      let manifest;
      try {
        manifest = JSON.parse(record.body);
      } catch {
        throw new Error("当前提交的发布清单无法校验");
      }
      if (
        !manifest ||
        Object.keys(manifest).sort().join(",") !==
          "image,revision,schema_hash,version" ||
        manifest.version !== expected.version ||
        manifest.revision !== expected.revision ||
        manifest.schema_hash !== expected.schema_hash ||
        typeof manifest.image !== "string" ||
        !manifest.image.startsWith(expected.image + "@sha256:") ||
        !/^[a-f0-9]{64}$/.test(
          manifest.image.slice((expected.image + "@sha256:").length),
        )
      )
        throw new Error("当前提交的镜像、版本或数据库结构不匹配");
      return manifest;
    }
    if (records.length < 100) return null;
  }
  throw new Error("发布记录未完整核对");
}
