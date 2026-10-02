import fs from "node:fs/promises";
import path from "node:path";
export const PACKAGE_LIMIT = 2 * 1024 ** 3;
export const packageRoot = path.join(process.cwd(), "public/uploads/alcor-test/packages");
export const metadataRoot = path.join(process.cwd(), "data/app-packages");
export type AppPackage = { id: string; name: string; size: number; platform: string; createdAt: string };
export async function listPackages(): Promise<AppPackage[]> {
  await fs.mkdir(metadataRoot, { recursive: true });
  const items = await Promise.all((await fs.readdir(metadataRoot)).filter(n => /^[a-f0-9]{32}\.json$/.test(n)).map(async n => {
    try { const item: AppPackage = JSON.parse(await fs.readFile(path.join(metadataRoot, n), "utf8")); if (item.id + ".json" !== n) return null; await fs.stat(path.join(packageRoot, item.id)); return item; } catch { return null; }
  }));
  return items.filter((i): i is AppPackage => !!i).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
