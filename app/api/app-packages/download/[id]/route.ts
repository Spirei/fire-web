import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { packageRoot, metadataRoot } from "@/lib/appPackages";
export const runtime = "nodejs";
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response("Not Found", { status: 404 });
  try {
    const item = JSON.parse(await fs.readFile(path.join(metadataRoot, id + ".json"), "utf8"));
    const file = path.join(packageRoot, id); const stat = await fs.stat(file);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, { headers: {
      "Content-Type": "application/octet-stream", "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.name).replace(/'/g, "%27")}`,
      "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"
    } });
  } catch { return new Response("Not Found", { status: 404 }); }
}
