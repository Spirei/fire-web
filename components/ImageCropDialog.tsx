"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconMinus, IconPlus, IconRefresh } from "@tabler/icons-react";
import AppModal, { ModalActions } from "@/components/AppModal";
import { Capsule, IconButton } from "@/components/Capsule";
import { clampCrop, cropGeometry, type CropPoint } from "@/lib/imageCrop";

export type CropKind = "avatar" | "background";

export default function ImageCropDialog({ file, kind, aspect = 2, onClose, onSave }: { file: File; kind: CropKind; aspect?: number; onClose: () => void; onSave: (file: File) => void }) {
  const frame = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; position: CropPoint } | null>(null);
  const [url, setUrl] = useState(""), [natural, setNatural] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState({ width: 1, height: 1 }), [position, setPosition] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    const source = URL.createObjectURL(file); setUrl(source);
    return () => URL.revokeObjectURL(source);
  }, [file]);
  useLayoutEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(frame.current); return () => observer.disconnect();
  }, [url]);
  const ready = natural.width > 0 && natural.height > 0;
  const geometry = ready ? cropGeometry(natural, size, zoom, position) : null;
  async function save() {
    if (!geometry || !image.current || busy) return;
    setBusy(true); setError("");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = kind === "avatar" ? 512 : 2048; canvas.height = kind === "avatar" ? 512 : Math.round(2048 / Math.max(.5, Math.min(6, aspect)));
      const context = canvas.getContext("2d"); if (!context) throw Error("图片处理失败");
      context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image.current, geometry.sx, geometry.sy, geometry.sw, geometry.sh, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error("图片处理失败")), "image/jpeg", .9));
      onSave(new File([blob], `${kind}.jpg`, { type: "image/jpeg" }));
    } catch (e) { setError(e instanceof Error ? e.message : "图片处理失败"); setBusy(false); }
  }
  return <AppModal title={kind === "avatar" ? "调整头像" : "调整背景图"} size="md" onClose={onClose} closeDisabled={busy} priority>
    <div ref={frame} className={`image-crop-frame ${kind === "avatar" ? "is-avatar" : "is-background"}`} style={kind === "background" ? { aspectRatio: Math.max(.5, Math.min(6, aspect)) } : undefined} role="img" aria-label={kind === "avatar" ? "头像裁剪预览" : "背景图裁剪预览"} tabIndex={0}
      onKeyDown={event => { const delta = { ArrowLeft: [-.08, 0], ArrowRight: [.08, 0], ArrowUp: [0, -.08], ArrowDown: [0, .08] }[event.key]; if (delta) { event.preventDefault(); setPosition(p => ({ x: clampCrop(p.x + delta[0]), y: clampCrop(p.y + delta[1]) })); } }}
      onPointerDown={event => { if (!ready || busy) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, position }; }}
      onPointerMove={event => { const start = drag.current; if (!start || start.id !== event.pointerId || !geometry) return; setPosition({ x: geometry.overflowX ? clampCrop(start.position.x + (event.clientX - start.x) / geometry.overflowX) : 0, y: geometry.overflowY ? clampCrop(start.position.y + (event.clientY - start.y) / geometry.overflowY) : 0 }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {url && <img ref={image} src={url} alt="" draggable={false} onLoad={e => { const img = e.currentTarget; setNatural({ width: img.naturalWidth, height: img.naturalHeight }); }} onError={() => setError("图片无法读取")} style={geometry ? { width: geometry.width, height: geometry.height, left: geometry.left, top: geometry.top } : { visibility: "hidden" }} />}
      <span className="image-crop-guide" aria-hidden="true" />
    </div>
    <div className="image-crop-tools">
      <IconButton label="缩小图片" title="缩小图片" disabled={!ready || busy || zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - .2))}><IconMinus size={18} /></IconButton>
      <input type="range" aria-label="缩放图片" min="1" max="4" step="0.01" value={zoom} disabled={!ready || busy} onChange={e => setZoom(Number(e.target.value))} />
      <IconButton label="放大图片" title="放大图片" disabled={!ready || busy || zoom >= 4} onClick={() => setZoom(z => Math.min(4, z + .2))}><IconPlus size={18} /></IconButton>
      <IconButton label="重置位置" title="重置位置" disabled={!ready || busy} onClick={() => { setZoom(1); setPosition({ x: 0, y: 0 }); }}><IconRefresh size={18} /></IconButton>
    </div>
    {error && <p role="alert" className="text-sm text-up">{error}</p>}
    <ModalActions><Capsule variant="secondary" disabled={busy} onClick={onClose}>取消</Capsule><Capsule variant="primary" disabled={!ready || !!error || busy} onClick={() => void save()}>{busy ? "处理中…" : "保存"}</Capsule></ModalActions>
  </AppModal>;
}

export function useImageCrop() {
  const [request, setRequest] = useState<{ file: File; kind: CropKind; aspect?: number } | null>(null);
  const resolver = useRef<((file: File | null) => void) | null>(null);
  useEffect(() => () => { resolver.current?.(null); resolver.current = null; }, []);
  function finish(file: File | null) { resolver.current?.(file); resolver.current = null; setRequest(null); }
  return {
    crop: (file: File, kind: CropKind, aspect?: number) => new Promise<File | null>(resolve => {
      resolver.current?.(null); resolver.current = resolve; setRequest({ file, kind, aspect });
    }),
    dialog: request ? <ImageCropDialog key={`${request.file.name}-${request.file.lastModified}-${request.kind}`} {...request} onClose={() => finish(null)} onSave={finish} /> : null,
  };
}
