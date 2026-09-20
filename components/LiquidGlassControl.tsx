"use client";
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { glassDisplacement, glassPosition } from "@/lib/liquidGlass";
import { useSitePalette } from "./PaletteProvider";
export interface GlassItem { label: string; icon?: ReactNode; color?: string }
/** Same visible track inside/outside the moving lens; no duplicated interactive controls. */
export default function LiquidGlassControl({ items, index, onChange, label, swatches = false, inactive = false }: {
  items: readonly GlassItem[]; index: number; onChange: (index: number) => void; label: string; swatches?: boolean; inactive?: boolean;
}) {
  const { palette } = useSitePalette();
  const glass = palette === "liquid";
  const id = useId().replace(/:/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const positionRef = useRef(index);
  // Keep a committed lens seated until the mouse deliberately moves again.
  const landedAt = useRef<{ x: number; y: number } | null>(null);
  const [position, setPosition] = useState(index);
  const [held, setHeld] = useState(false);
  const [hovered, setHovered] = useState(false);
  const active = held || hovered;
  const [map, setMap] = useState("");
  useEffect(() => { if (pointer.current === null) { positionRef.current = index; setPosition(index); } }, [index]);
  useEffect(() => {
    if (!glass || !ref.current) return;
    const update = () => {
      const bounds = ref.current!.getBoundingClientRect();
      const width = Math.max(2, Math.round((bounds.width - 8) / items.length));
      const height = Math.max(2, Math.round(bounds.height - 8));
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx) { const pixels = ctx.createImageData(width,height); pixels.data.set(glassDisplacement(width,height)); ctx.putImageData(pixels,0,0); setMap(canvas.toDataURL()); }
    };
    const observer = new ResizeObserver(update); observer.observe(ref.current); update();
    return () => observer.disconnect();
  }, [glass,items.length]);
  const updatePosition = (x: number) => {
    const r = ref.current!.getBoundingClientRect();
    const p = glassPosition(x, r.left + 4, r.width - 8, items.length);
    positionRef.current = p; setPosition(p);
  };
  const cancel = () => { landedAt.current = null; pointer.current = null; setHeld(false); setHovered(false); positionRef.current = index; setPosition(index); };
  useEffect(() => { window.addEventListener("blur", cancel); return () => window.removeEventListener("blur", cancel); }, [index]);
  useEffect(() => { if (!glass) cancel(); }, [glass]);
  const hover = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!glass || pointer.current !== null || event.pointerType !== "mouse" || event.buttons !== 0) return;
    if (landedAt.current) {
      if (Math.hypot(event.clientX - landedAt.current.x, event.clientY - landedAt.current.y) < 6) return;
      landedAt.current = null;
    }
    setHovered(true); updatePosition(event.clientX);
  };
  const content = (item: GlassItem) => <>{item.color ? <i className="lg-swatch" style={{ backgroundColor: item.color }} /> : <>{item.icon}<span>{item.label}</span></>}</>;
  return <div ref={ref} className={`lg-control${glass ? " lg-optical" : ""}${swatches ? " lg-colors" : ""}${active ? " lg-active" : ""}${inactive && !active ? " lg-inactive" : ""}`}
    role="group" aria-label={label} style={{ "--lg-count": items.length, "--lg-position": position } as CSSProperties}
    onPointerDown={event => { if (!glass || pointer.current !== null || !event.isPrimary || event.button !== 0) return; landedAt.current = null; pointer.current = event.pointerId; ref.current?.setPointerCapture(event.pointerId); setHeld(true); updatePosition(event.clientX); }}
    onPointerEnter={hover}
    onPointerMove={event => { if (pointer.current === event.pointerId) updatePosition(event.clientX); else hover(event); }}
    onPointerLeave={() => { if (pointer.current === null) cancel(); else setHovered(false); }}
    onPointerUp={event => { if(pointer.current !== event.pointerId) return; const selected = Math.round(positionRef.current); pointer.current = null; setHeld(false); setHovered(false); landedAt.current = event.pointerType === "mouse" ? { x: event.clientX, y: event.clientY } : null; setPosition(selected); positionRef.current = selected; if(ref.current?.hasPointerCapture(event.pointerId)) ref.current.releasePointerCapture(event.pointerId); onChange(selected); }}
    onPointerCancel={cancel} onLostPointerCapture={() => { if(pointer.current !== null) cancel(); }}>
    <div className="lg-track">{items.map((item,i) => <button type="button" key={item.label} aria-label={item.label} aria-pressed={!inactive && index === i}
      onClick={event => { if (!glass || event.detail === 0) onChange(i); }}>{content(item)}</button>)}</div>
    <div className="lg-lens" aria-hidden="true" inert>
      <div className="lg-lens-body">
        <div className="lg-refraction" style={map ? { backdropFilter: `url(#${id}-optics)`, WebkitBackdropFilter: `url(#${id}-optics)` } : undefined} />
        <div className="lg-magnify" style={map ? { filter: `url(#${id}-optics)` } : undefined}>
          <div className="lg-copy-track">{items.map(item => <span className="lg-copy-item" key={item.label}>{content(item)}</span>)}</div>
        </div>
      </div>
    </div>
    {glass && map && <svg className="lg-filter-defs" aria-hidden="true" width="0" height="0"><defs>
      <filter id={`${id}-optics`} x="-12%" y="-20%" width="124%" height="140%" colorInterpolationFilters="sRGB">
        <feImage href={map} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="rim" />
        <feDisplacementMap in="SourceGraphic" in2="rim" scale="9" xChannelSelector="R" yChannelSelector="G" result="red" />
        <feDisplacementMap in="SourceGraphic" in2="rim" scale="7" xChannelSelector="R" yChannelSelector="G" result="green" />
        <feDisplacementMap in="SourceGraphic" in2="rim" scale="5" xChannelSelector="R" yChannelSelector="G" result="blue" />
        <feColorMatrix in="red" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
        <feColorMatrix in="green" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
        <feColorMatrix in="blue" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
        <feBlend in="r" in2="g" mode="screen" result="rg" /><feBlend in="rg" in2="b" mode="screen" />
      </filter>
    </defs></svg>}
  </div>;
}
