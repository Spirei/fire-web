import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { listCardAmounts, listCardTags } from "@/lib/cardAmounts";

export const dynamic = "force-dynamic";

/** 卡面库清单：读取 public/uploads/cards/manifest.json（由 scripts/fetch-card-assets.mjs 生成） */
const CARDS_DIR = path.join(process.cwd(), "public", "uploads", "cards");
const MANIFEST = path.join(CARDS_DIR, "manifest.json");

let cache: { data: unknown; at: number } | null = null;
const CACHE_TTL = 60 * 1000;

function readManifest() {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.data;
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    cache = { data: parsed, at: Date.now() };
    return parsed;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const manifest = readManifest() as
    | { generatedAt?: string; source?: string; typeOrder?: string[]; regions?: unknown[] }
    | null;
  if (!manifest || !Array.isArray(manifest.regions)) {
    return NextResponse.json(
      {
        regions: [],
        typeOrder: [],
        updatedAt: null,
        error: "还没有卡面素材：在项目根目录执行 node scripts/fetch-card-assets.mjs 抓取"
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(
    {
      regions: manifest.regions,
      typeOrder: Array.isArray(manifest.typeOrder) ? manifest.typeOrder : [],
      updatedAt: manifest.generatedAt ?? null,
      source: manifest.source ?? "",
      amounts: listCardAmounts(user.id),
      tags: listCardTags(user.id)
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
