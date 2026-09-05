import { stat } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.NODE_ENV !== "development") return new Response("", { status: 204 });
  const root = process.cwd();
  const files = [
    path.join(root, "public", "simple-app-runtime.js"),
    path.join(root, "app", "simple-app", "simple-app.css"),
    path.join(root, "app", "simple-app", "SimpleAppClient.tsx")
  ];
  const versions = await Promise.all(files.map(async (file) => (await stat(file)).mtimeMs));
  return new Response(versions.join(":"), {
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }
  });
}
