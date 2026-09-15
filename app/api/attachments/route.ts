import { readFormBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import {
  AttachmentConflictError,
  attachmentExists,
  copyAttachment,
  createAttachmentDir,
  deleteAttachment,
  listAttachmentDirectories,
  listAttachments,
  moveAttachment,
  readAttachment,
  writeAttachment
} from "@/lib/attachments";

export const dynamic = "force-dynamic";

const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB

function requireAdmin(request: Request) {
  const user = getAuthUser(request);
  if (!user) return { error: NextResponse.json({ error: "未登录" }, { status: 401 }) };
  if (!isAdmin(user)) return { error: NextResponse.json({ error: "需要管理员权限" }, { status: 403 }) };
  return { user };
}

function safeFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return base || `file-${Date.now()}`;
}

function contentType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      pdf: "application/pdf",
      txt: "text/plain; charset=utf-8",
      md: "text/markdown; charset=utf-8",
      csv: "text/csv; charset=utf-8",
      json: "application/json; charset=utf-8",
      xml: "application/xml; charset=utf-8",
      html: "text/plain; charset=utf-8"
    } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}

function conflictMode(value: FormDataEntryValue | null) {
  return value === "replace" || value === "keep-both" ? value : "error";
}

function operationError(err: unknown, fallback: string) {
  if (err instanceof AttachmentConflictError) {
    return NextResponse.json(
      { error: err.message, code: err.code, path: err.rel },
      { status: 409 }
    );
  }
  return NextResponse.json({ error: err instanceof Error ? err.message : fallback }, { status: 400 });
}

export async function GET(request: Request) {
  const auth = requireAdmin(request);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const rel = searchParams.get("path") ?? "";
  if (searchParams.get("action") === "directories") {
    try {
      return NextResponse.json({ directories: listAttachmentDirectories() });
    } catch (err) {
      return operationError(err, "读取目录失败");
    }
  }
  if (searchParams.get("action") === "download") {
    try {
      const { buffer, name } = readAttachment(rel);
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
        }
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "下载失败" }, { status: 400 });
    }
  }
  if (searchParams.get("action") === "preview") {
    try {
      const { buffer, name } = readAttachment(rel);
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "Content-Type": contentType(name),
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "预览失败" }, { status: 400 });
    }
  }
  try {
    const data = listAttachments(rel);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "读取失败" }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const auth = requireAdmin(request);
  if ("error" in auth) return auth.error;

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_UPLOAD + 1024 * 1024) {
    return NextResponse.json({ error: "单个文件最大 50MB" }, { status: 413 });
  }

  const form = await readFormBody(request).catch(() => null);
  if (!form) return NextResponse.json({ error: "无效的请求" }, { status: 400 });
  const action = String(form.get("action") ?? "upload");
  const parent = String(form.get("dir") ?? form.get("parent") ?? "").trim();

  if (action === "mkdir") {
    const name = safeFileName(String(form.get("name") ?? "").trim());
    if (!name) return NextResponse.json({ error: "缺少目录名称" }, { status: 400 });
    try {
      const target = parent ? `${parent}/${name}` : name;
      if (attachmentExists(target)) {
        return NextResponse.json(
          { error: "同名目录已存在", code: "ATTACHMENT_EXISTS", path: target },
          { status: 409 }
        );
      }
      createAttachmentDir(target);
      return NextResponse.json({ ok: true, path: target });
    } catch (err) {
      return operationError(err, "创建目录失败");
    }
  }

  if (action === "rename" || action === "move" || action === "copy") {
    const source = String(form.get("source") ?? "").trim();
    const targetDir = String(form.get("targetDir") ?? "").trim();
    const name = action === "rename" ? safeFileName(String(form.get("name") ?? "").trim()) : undefined;
    if (!source) return NextResponse.json({ error: "缺少源路径" }, { status: 400 });
    if (action === "rename" && !name) return NextResponse.json({ error: "缺少新名称" }, { status: 400 });
    try {
      const currentParent = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
      const path =
        action === "copy"
          ? copyAttachment(source, targetDir, conflictMode(form.get("conflict")))
          : moveAttachment(
              source,
              action === "rename" ? currentParent : targetDir,
              name,
              conflictMode(form.get("conflict"))
            );
      return NextResponse.json({ ok: true, path });
    } catch (err) {
      return operationError(err, action === "copy" ? "复制失败" : action === "move" ? "移动失败" : "重命名失败");
    }
  }

  // 上传附件
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "缺少文件" }, { status: 400 });
  if (file.size > MAX_UPLOAD) return NextResponse.json({ error: "单个文件最大 50MB" }, { status: 400 });
  const name = safeFileName(file.name);
  const rel = parent ? `${parent}/${name}` : name;
  try {
    if (conflictMode(form.get("conflict")) === "error" && attachmentExists(rel)) {
      return NextResponse.json(
        { error: "同名文件已存在", code: "ATTACHMENT_EXISTS", path: rel },
        { status: 409 }
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const actualRel = writeAttachment(rel, buffer, conflictMode(form.get("conflict")));
    return NextResponse.json({ ok: true, path: actualRel, size: buffer.length });
  } catch (err) {
    return operationError(err, "上传失败");
  }
}

export async function DELETE(request: Request) {
  const auth = requireAdmin(request);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const rel = searchParams.get("path") ?? "";
  const force = searchParams.get("force") === "1";
  if (!rel) return NextResponse.json({ error: "缺少路径" }, { status: 400 });
  try {
    deleteAttachment(rel, force);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "删除失败" }, { status: 400 });
  }
}
