import { NextResponse } from "next/server";
import sharp from "sharp";
import {
  getAuthUser,
  isTrustedMutationRequest,
  updateProfile,
} from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  personalProfile,
  personalBackground,
  mutatePersonalProfile,
} from "@/lib/personalProfile";
import {
  readJsonBody,
  readFormBody,
  RequestBodyTooLargeError,
} from "@/lib/requestBody";
import { RecordsError } from "@/lib/recordsContract";
import { rateLimit } from "@/lib/rateLimit";
export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store, private" },
  });
export async function GET(request: Request) {
  const user = request.headers.has("authorization")
    ? null
    : getAuthUser(request);
  if (!user) return json({ error: "未登录" }, 401);
  const p = new URL(request.url).searchParams;
  if (
    [...p.keys()].some((k) => !["kind", "v"].includes(k)) ||
    (p.size && p.get("kind") !== "background")
  )
    return json({ error: "参数无效" }, 400);
  try {
    if (p.get("kind") === "background")
      return new Response(new Uint8Array(personalBackground(user.id)), {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-store, private",
          "X-Content-Type-Options": "nosniff",
        },
      });
    return json({ user, profile: personalProfile(user.id, 1) });
  } catch (error) {
    return json(
      { error: error instanceof RecordsError ? error.message : "资料读取失败" },
      error instanceof RecordsError ? error.status : 500,
    );
  }
}
async function mutate(request: Request) {
  try {
    const user = request.headers.has("authorization")
      ? null
      : getAuthUser(request);
    if (!user) return json({ error: "未登录" }, 401);
    if (!isTrustedMutationRequest(request))
      return json({ error: "无效来源" }, 403);
    if (!rateLimit(`web-personal-home:${user.id}`, 30, 60000))
      return json({ error: "保存过于频繁" }, 429);
    const authorize = () => {
      const current = getAuthUser(request);
      if (!current || current.id !== user.id)
        throw new RecordsError("登录已变化", 401);
      return current.id;
    };
    let raw: Record<string, unknown>, bytes: Buffer | undefined;
    if (request.method === "POST") {
      const form = await readFormBody(request, 8388608 + 16384),
        file = form.get("file");
      if (
        ["file", "requestId", "revision"].some(
          (k) => form.getAll(k).length !== 1,
        ) ||
        typeof form.get("revision") !== "string" ||
        !/^(0|[1-9]\d*)$/.test(String(form.get("revision")))
      )
        throw new RecordsError("表单字段无效");
      if (
        !file ||
        typeof file === "string" ||
        file.size > 8388608 ||
        file.size === 0 ||
        [...form.keys()].some(
          (k) => !["file", "requestId", "revision"].includes(k),
        )
      )
        throw new RecordsError("图片表单无效");
      try {
        const image = sharp(Buffer.from(await file.arrayBuffer()), {
          limitInputPixels: 4194304,
          failOn: "warning",
        });
        const meta = await image.metadata();
        if (!["jpeg", "png", "webp"].includes(meta.format || "")) throw Error();
        bytes = await image
          .rotate()
          .resize({
            width: 2048,
            height: 2048,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 88 })
          .toBuffer();
      } catch {
        throw new RecordsError(
          "图片无法读取，请使用不超过400万像素的 JPEG、PNG 或 WebP 图片",
        );
      }
      raw = {
        requestId: form.get("requestId"),
        revision: Number(form.get("revision")),
      };
    } else {
      raw = await readJsonBody(request, 16384);
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).some(
          (k) =>
            !["requestId", "revision", "nickname", "bio", "gender"].includes(k),
        )
      )
        throw new RecordsError("包含不可编辑的字段");
    }
    const nickname = raw.nickname;
    if (
      nickname !== undefined &&
      (typeof nickname !== "string" ||
        Array.from(nickname).length > 20 ||
        /[\x00-\x1f\x7f]/.test(nickname))
    )
      throw new RecordsError("昵称最多20个字符");
    const body = {
      requestId: raw.requestId,
      revision: raw.revision,
      ...(bytes ? {} : { changes: { bio: raw.bio, gender: raw.gender } }),
    };
    const result = getDb()
      .transaction(() => {
        authorize();
        const output = mutatePersonalProfile(
          user.id,
          body,
          1,
          authorize,
          bytes,
        );
        if (!output.error && nickname !== undefined)
          updateProfile(user.id, { nickname: String(nickname).trim() });
        return output;
      })
      .immediate();
    if (result.error)
      return json(
        { error: result.error.message, requestId: raw.requestId },
        result.error.status,
      );
    return json({
      user: getAuthUser(request),
      profile: personalProfile(user.id, 1),
      requestId: raw.requestId,
    });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "保存失败" },
      e instanceof RecordsError
        ? e.status
        : e instanceof RequestBodyTooLargeError
          ? 413
          : 500,
    );
  }
}
export const PATCH = mutate;
export const POST = mutate;
