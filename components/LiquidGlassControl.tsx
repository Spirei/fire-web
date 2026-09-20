"use client";
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { glassDisplacement, glassFrame, glassPosition, stepGlassSpring } from "@/lib/liquidGlass";
import { useSitePalette } from "./PaletteProvider";

export interface GlassItem { label: string; icon?: ReactNode; color?: string }
const LONG_PRESS_MS = 320;
const PRESS_SLOP_PX = 8;

export default function LiquidGlassControl({ items, index, onChange, label, swatches = false, inactive = false }: {
  items: readonly GlassItem[]; index: number; onChange: (index: number) => void; label: string; swatches?: boolean; inactive?: boolean;
}) {
  const { palette } = useSitePalette();
  const glass = palette === "liquid";
  const id = useId().replace(/:/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState("");
  const current = useRef({ index, onChange, glass, inactive, count: items.length });
  current.current = { index, onChange, glass, inactive, count: items.length };
  const motion = useRef({
    x: { value: index, velocity: 0 }, lift: { value: 0, velocity: 0 }, target: index,
    raised: false, pulse: 0, pointer: null as number | null, pressX: 0, pressY: 0, lastX: 0, cancelled: false,
    bounds: { left: 0, top: 0, width: 1, height: 44 }, slot: 1,
    timer: null as ReturnType<typeof setTimeout> | null, raf: 0, lastTime: 0, reduced: false,
  });

  const paint = () => {
    const el = ref.current, m = motion.current;
    if (!el) return;
    const f = glassFrame(m.x.value, m.lift.value, m.x.velocity, m.slot, m.bounds.height);
    const optical = current.current.glass && f.lift > .002;
    el.dataset.raised = optical ? "true" : "false";
    el.dataset.dragging = m.raised ? "true" : "false";
    const values: Record<string, string> = {
      "--lg-x": `${f.left}px`, "--lg-y": `${f.top}px`, "--lg-width": `${f.width}px`, "--lg-height": `${f.height}px`,
      "--lg-track-width": `${m.slot * current.current.count}px`, "--lg-copy-x": `${f.copyX}px`,
      "--lg-zoom": `${f.zoom}`, "--lg-lift": `${f.lift}`,
      "--lg-cut-left": `${Math.max(0, f.left + 2)}px`, "--lg-cut-right": `${Math.max(0, f.left + f.width - 2)}px`,
    };
    for (const [key, value] of Object.entries(values)) el.style.setProperty(key, value);
    el.style.setProperty("--lg-visible", current.current.inactive && !optical ? "0" : "1");
  };
  const tick = (time: number) => {
    const m = motion.current;
    const dt = m.lastTime ? (time - m.lastTime) / 1000 : 1 / 60;
    m.lastTime = time;
    m.pulse = Math.max(0, m.pulse - dt);
    const liftTarget = m.raised ? 1 : m.pulse > 0 ? .92 : 0;
    m.x = stepGlassSpring(m.x, m.target, dt, m.raised ? 48 : 28);
    m.lift = stepGlassSpring(m.lift, liftTarget, dt, liftTarget ? 42 : 26);
    const done = m.pulse === 0 && Math.abs(m.x.value - m.target) < .0001 && Math.abs(m.x.velocity) < .001 && Math.abs(m.lift.value - liftTarget) < .0001 && Math.abs(m.lift.velocity) < .001;
    if (done) { m.x = { value: m.target, velocity: 0 }; m.lift = { value: liftTarget, velocity: 0 }; }
    paint();
    m.raf = done ? 0 : requestAnimationFrame(tick);
    if (done) m.lastTime = 0;
  };
  const animate = () => {
    const m = motion.current;
    if (m.reduced || !current.current.glass) {
      m.pulse = 0;
      m.x = { value: m.target, velocity: 0 }; m.lift = { value: 0, velocity: 0 }; paint(); return;
    }
    if (!m.raf) m.raf = requestAnimationFrame(tick);
  };
  const clearPressTimer = () => {
    if (motion.current.timer !== null) clearTimeout(motion.current.timer);
    motion.current.timer = null;
  };
  const release = () => {
    const m = motion.current, pointer = m.pointer;
    m.pointer = null; m.raised = false; clearPressTimer();
    if (pointer !== null && ref.current?.hasPointerCapture(pointer)) ref.current.releasePointerCapture(pointer);
  };
  const cancel = () => { release(); motion.current.pulse = 0; motion.current.target = current.current.index; animate(); };
  const positionAt = (x: number) => {
    const m = motion.current;
    return glassPosition(x, m.bounds.left, m.bounds.width, current.current.count);
  };

  useEffect(() => {
    if (motion.current.pointer === null) { motion.current.target = index; animate(); }
  }, [index, inactive]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect(), border = el.clientLeft;
      const width = el.clientWidth - 8, height = el.clientHeight - 8;
      if (width <= 0 || height <= 0 || !items.length) return;
      motion.current.bounds = { left: r.left + border + 4, top: r.top + border + 4, width, height };
      motion.current.slot = width / items.length;
      if (glass) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(2, Math.round(width / items.length)); canvas.height = Math.max(2, height);
        const ctx = canvas.getContext("2d");
        if (ctx) { const pixels = ctx.createImageData(canvas.width, canvas.height); pixels.data.set(glassDisplacement(canvas.width, canvas.height)); ctx.putImageData(pixels, 0, 0); setMap(canvas.toDataURL()); }
      }
      paint();
    };
    const observer = new ResizeObserver(update); observer.observe(el); update();
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const reduce = () => { motion.current.reduced = media.matches; cancelAnimationFrame(motion.current.raf); motion.current.raf = 0; motion.current.lastTime = 0; animate(); };
    motion.current.reduced = media.matches;
    media.addEventListener("change", reduce);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    if (!glass) cancel();
    return () => { observer.disconnect(); media.removeEventListener("change", reduce); window.removeEventListener("blur", cancel); window.removeEventListener("resize", cancel); clearPressTimer(); cancelAnimationFrame(motion.current.raf); motion.current.raf = 0; };
  }, [glass, items.length]);

  const content = (item: GlassItem) => item.color ? <i className="lg-swatch" style={{ backgroundColor: item.color }} /> : <>{item.icon}<span>{item.label}</span></>;
  return <div ref={ref} className={`lg-control${glass ? " lg-optical" : ""}${swatches ? " lg-colors" : ""}`}
    role="group" aria-label={label} style={{ "--lg-count": items.length, "--lg-visible": inactive ? 0 : 1 } as CSSProperties}
    onPointerDown={event => {
      const m = motion.current;
      if (!glass || m.pointer !== null || !event.isPrimary || event.button !== 0) return;
      const el = ref.current!, r = el.getBoundingClientRect();
      m.bounds.left = r.left + el.clientLeft + 4; m.bounds.top = r.top + el.clientTop + 4;
      m.pointer = event.pointerId; m.pressX = m.lastX = event.clientX; m.pressY = event.clientY; m.cancelled = false;
      el.setPointerCapture(event.pointerId);
      const pointer = event.pointerId;
      m.timer = setTimeout(() => {
        m.timer = null;
        if (m.pointer !== pointer || m.cancelled) return;
        m.raised = true; m.target = positionAt(m.lastX); animate();
      }, LONG_PRESS_MS);
    }}
    onPointerMove={event => {
      const m = motion.current;
      if (m.pointer !== event.pointerId) return;
      m.lastX = event.clientX;
      if (m.raised) { m.target = positionAt(event.clientX); animate(); }
      else if (Math.hypot(event.clientX - m.pressX, event.clientY - m.pressY) > PRESS_SLOP_PX) { m.cancelled = true; clearPressTimer(); }
    }}
    onPointerUp={event => {
      const m = motion.current;
      if (m.pointer !== event.pointerId) return;
      const inside = event.clientX >= m.bounds.left - 4 && event.clientX <= m.bounds.left + m.bounds.width + 4 && event.clientY >= m.bounds.top - 4 && event.clientY <= m.bounds.top + m.bounds.height + 4;
      if (!m.raised && (m.cancelled || !inside)) { cancel(); return; }
      const selected = Math.round(positionAt(event.clientX));
      if (!m.raised) m.pulse = .24;
      release(); m.target = selected; animate(); current.current.onChange(selected);
    }}
    onPointerCancel={cancel} onLostPointerCapture={() => { if (motion.current.pointer !== null) cancel(); }}>
    <div className="lg-track">{items.map((item, i) => <button type="button" key={item.label} aria-label={item.label} aria-pressed={!inactive && index === i}
      onClick={event => { if (!glass || event.detail === 0) { motion.current.target = i; motion.current.pulse = glass ? .24 : 0; animate(); onChange(i); } }}><span className="lg-original">{content(item)}</span></button>)}</div>
    <div className="lg-lens" aria-hidden="true" inert><div className="lg-lens-body">
      <div className="lg-copy-window"><div className="lg-magnify" style={glass && map ? { filter: `url(#${id}-rim)` } : undefined}>
        <div className="lg-copy-track">{items.map(item => <span className="lg-copy-item" key={item.label}>{content(item)}</span>)}</div>
      </div></div>
    </div></div>
    {glass && map && <svg className="lg-filter-defs" aria-hidden="true" width="0" height="0"><defs>
      <filter id={`${id}-rim`} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feImage href={map} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="rim" />
        <feDisplacementMap in="SourceGraphic" in2="rim" scale="1.6" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </defs></svg>}
  </div>;
}
