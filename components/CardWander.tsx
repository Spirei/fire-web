"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import { flushSync } from "react-dom";
import { selectWanderCards } from "@/lib/cardWander";

export interface WanderCard {
  key: string;
  name: string;
  bank: string;
  region: string;
  type: string;
  image: string;
  held: boolean;
}

interface Props {
  cards: WanderCard[];
  seed: string;
  onClose: () => void;
  onShuffle: () => void;
  onOpenDetails: (key: string) => void;
  onToggleHeld: (key: string, held: boolean) => void;
}

const COLUMNS = 12;
const ROWS = 18;
const MIN_SCALE = 0.72;
const MAX_SCALE = 1.45;
const DRIFT_SPEED_PER_SECOND = 9.5;
const DRIFT_ANGLE_PER_SECOND = 0.0006;
const DRIFT_TRAVEL_X = 320;
const DRIFT_TRAVEL_Y = 180;
type PreviewEffect = "gloss" | "holo" | "metal" | "pulse" | "stardust";
type PreviewMode = "showcase" | "wallet" | "actual";
const PREVIEW_MODES: { key: PreviewMode; label: string }[] = [
  { key: "showcase", label: "展示" },
  { key: "wallet", label: "钱包" },
  { key: "actual", label: "原尺寸" }
];
const PREVIEW_EFFECTS: { key: PreviewEffect; label: string }[] = [
  { key: "gloss", label: "光泽" },
  { key: "holo", label: "幻彩" },
  { key: "metal", label: "金属" },
  { key: "pulse", label: "脉冲" },
  { key: "stardust", label: "星砂" }
];

function newPosition() { return { x: 0, y: 0, scale: 1 }; }

function WanderTile({ card, observeTile, onSelect }: {
  card: WanderCard;
  observeTile: (tile: HTMLButtonElement, onNear: () => void) => () => void;
  onSelect: (card: WanderCard, tile: HTMLButtonElement) => void;
}) {
  const tileRef = useRef<HTMLButtonElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  useEffect(() => {
    const tile = tileRef.current;
    if (!tile) return;
    return observeTile(tile, () => setNearViewport(true));
  }, [observeTile]);
  return (
    <button
      ref={tileRef}
      type="button"
      className="card-wander-tile"
      data-wander-key={card.key}
      aria-label={card.name}
      onClick={(event) => onSelect(card, event.currentTarget)}
    >
      {nearViewport && <img src={card.image} alt="" draggable={false} loading="eager" decoding="async" />}
    </button>
  );
}

export default function CardWander({ cards, seed, onClose, onShuffle, onOpenDetails, onToggleHeld }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const wallRef = useRef<HTMLDivElement>(null);
  const tileObserverRef = useRef<IntersectionObserver | null>(null);
  const tileNearCallbacksRef = useRef(new Map<Element, () => void>());
  const hoverFrameRef = useRef<number | null>(null);
  const hoverPointRef = useRef<{ x: number; y: number; target: HTMLButtonElement | null } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const modalCloseRef = useRef<HTMLButtonElement>(null);
  const zoomSourceRef = useRef<HTMLButtonElement>(null);
  const positionRef = useRef(newPosition());
  const driftDirectionRef = useRef({ x: -1, y: -1, angle: 0.04 });
  const driftAnchorRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ id: number; x: number; y: number; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [selected, setSelected] = useState<WanderCard | null>(null);
  const [previewEffect, setPreviewEffect] = useState<PreviewEffect>("gloss");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("showcase");
  const [walletPayment, setWalletPayment] = useState(false);
  const sourceTileRef = useRef<HTMLButtonElement | null>(null);
  const hoveredTileRef = useRef<HTMLButtonElement | null>(null);
  const flightRef = useRef<HTMLImageElement | null>(null);
  const previewClosingRef = useRef(false);
  const shufflingRef = useRef(false);
  const actualRef = useRef<HTMLDivElement>(null);
  const actualDragRef = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const effectTiltRef = useRef<HTMLDivElement>(null);
  const effectGlareRef = useRef<HTMLSpanElement>(null);
  const effectSpecRef = useRef<HTMLSpanElement>(null);
  const effectFrameRef = useRef<number | null>(null);
  const effectPointRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const effectRectRef = useRef<DOMRect | null>(null);
  const effectPressRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoomEffect, setZoomEffect] = useState<PreviewEffect>("gloss");
  const zoomEffectBagRef = useRef<PreviewEffect[]>([]);
  const previousZoomEffectRef = useRef<PreviewEffect | null>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const zoomImageRef = useRef<HTMLDivElement>(null);
  const zoomCloseRef = useRef<HTMLButtonElement>(null);
  const zoomClosingRef = useRef(false);

  const deck = useMemo(() => selectWanderCards(cards, seed, COLUMNS * ROWS), [cards, seed]);
  const columns = useMemo(() => Array.from({ length: COLUMNS }, (_, column) =>
    deck.slice(column * ROWS, (column + 1) * ROWS)
  ), [deck]);
  const selectedCard = selected ? cards.find((card) => card.key === selected.key) ?? selected : null;

  const observeTile = useCallback((tile: HTMLButtonElement, onNear: () => void) => {
    const viewport = viewportRef.current;
    if (!viewport || !("IntersectionObserver" in window)) { onNear(); return () => {}; }
    if (!tileObserverRef.current) {
      tileObserverRef.current = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = tileNearCallbacksRef.current.get(entry.target);
          tileNearCallbacksRef.current.delete(entry.target);
          tileObserverRef.current?.unobserve(entry.target);
          callback?.();
        }
      }, { root: viewport, rootMargin: "360px" });
    }
    tileNearCallbacksRef.current.set(tile, onNear);
    tileObserverRef.current.observe(tile);
    return () => {
      tileObserverRef.current?.unobserve(tile);
      tileNearCallbacksRef.current.delete(tile);
    };
  }, []);

  function restoreSourceTile() {
    if (sourceTileRef.current) {
      sourceTileRef.current.style.visibility = "";
      sourceTileRef.current.style.transform = "";
      sourceTileRef.current.style.transition = "";
    }
    sourceTileRef.current = null;
    flightRef.current?.parentElement?.remove();
    flightRef.current = null;
  }

  function flyCard(source: Pick<DOMRect, "left" | "top" | "width" | "height">, target: Pick<DOMRect, "left" | "top" | "width" | "height">, image: string, closing = false) {
    const tile = sourceTileRef.current;
    const viewport = viewportRef.current?.getBoundingClientRect();
    const sourceX = source.left + source.width / 2;
    const sourceY = source.top + source.height / 2;
    const targetX = target.left + target.width / 2;
    const targetY = target.top + target.height / 2;
    const perspectiveX = window.innerWidth / 2;
    const perspectiveY = window.innerHeight / 2;
    const wallOriginY = viewport ? viewport.top + viewport.height / 2 : perspectiveY;
    const lift = tile ? new DOMMatrixReadOnly(getComputedStyle(tile).transform) : null;
    const depth = (sourceY - wallOriginY) * Math.sin(15 * Math.PI / 180) + (lift?.m43 || 0);
    const projection = 1500 / (1500 - depth);
    const offsetX = (sourceX - perspectiveX) / projection - (targetX - perspectiveX);
    const offsetY = (sourceY - perspectiveY) / projection - (targetY - perspectiveY);
    const wallScale = positionRef.current.scale;
    const scale = ((tile?.offsetWidth || source.width) * (lift?.m11 || 1) * wallScale) / target.width;
    // radius 在 transform 之前计算；反向补偿缩放，落位仍与原卡的 10px 圆角一致。
    const sourceRadius = tile ? parseFloat(getComputedStyle(tile).borderTopLeftRadius) || 10 : 10;
    const wallRadius = `${sourceRadius * (lift?.m11 || 1) * wallScale / scale}px`;
    const wallTransform = `translate3d(${offsetX}px, ${offsetY}px, ${depth}px) rotateX(15deg) rotateZ(-6deg) scale(${scale})`;
    const shell = document.createElement("div");
    Object.assign(shell.style, {
      position: "fixed", inset: "0", zIndex: "10050", pointerEvents: "none",
      perspective: "1500px", perspectiveOrigin: "50% 50%", transformStyle: "preserve-3d"
    });
    const flight = document.createElement("img");
    flight.src = image;
    flight.alt = "";
    flight.setAttribute("aria-hidden", "true");
    Object.assign(flight.style, {
      position: "absolute", left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, height: `${target.height}px`,
      objectFit: "contain", pointerEvents: "none", transformOrigin: "center",
      borderRadius: closing ? "17px" : wallRadius, boxShadow: "0 24px 60px rgba(0,0,0,.5)", willChange: "transform"
    });
    shell.appendChild(flight);
    document.body.appendChild(shell);
    flightRef.current = flight;
    const animation = flight.animate([
      { transform: closing ? "none" : wallTransform, borderRadius: closing ? "17px" : wallRadius },
      { transform: closing ? wallTransform : "none", borderRadius: closing ? wallRadius : "17px" }
    ], { duration: closing ? 500 : 620, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" });
    return animation.finished.then(() => {
      if (!closing && !previewClosingRef.current && modalRef.current) modalRef.current.dataset.landed = "true";
    }).catch(() => undefined).finally(() => {
      // 关闭时保留终帧，等遮罩结束后由 restoreSourceTile 同步换回原卡。
      if (!closing) {
        shell.remove();
        if (flightRef.current === flight) flightRef.current = null;
      }
    });
  }

  function selectTile(card: WanderCard, tile: HTMLButtonElement) {
    if (hoverFrameRef.current !== null) window.cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = null;
    hoverPointRef.current = null;
    const transform = getComputedStyle(tile).transform;
    tile.style.transition = "none";
    tile.style.transform = transform;
    setHoveredTile(null);
    sourceTileRef.current = tile;
    setPreviewMode("showcase");
    setWalletPayment(false);
    setSelected(card);
  }

  function findTileAtPoint(x: number, y: number) {
    const tiles = viewportRef.current?.querySelectorAll<HTMLButtonElement>(".card-wander-tile");
    if (!tiles) return null;
    let nearest: HTMLButtonElement | null = null;
    let distance = Infinity;
    for (const tile of tiles) {
      const rect = tile.getBoundingClientRect();
      const insetX = Math.min(12, rect.width * .04);
      const insetY = Math.min(8, rect.height * .04);
      if (x < rect.left + insetX || x > rect.right - insetX || y < rect.top + insetY || y > rect.bottom - insetY) continue;
      const score = ((x - rect.left - rect.width / 2) / rect.width) ** 2 + ((y - rect.top - rect.height / 2) / rect.height) ** 2;
      if (score < distance) { nearest = tile; distance = score; }
    }
    return nearest;
  }

  function setHoveredTile(tile: HTMLButtonElement | null) {
    if (hoveredTileRef.current === tile) return;
    if (hoveredTileRef.current) delete hoveredTileRef.current.dataset.hovered;
    hoveredTileRef.current = tile;
    if (tile) tile.dataset.hovered = "true";
  }

  function queueHoveredTile(x: number, y: number, target: HTMLButtonElement | null) {
    hoverPointRef.current = { x, y, target };
    if (hoverFrameRef.current !== null) return;
    hoverFrameRef.current = window.requestAnimationFrame(() => {
      hoverFrameRef.current = null;
      const point = hoverPointRef.current;
      hoverPointRef.current = null;
      if (!point || sourceTileRef.current || dragRef.current?.moved) return;
      setHoveredTile(point.target || findTileAtPoint(point.x, point.y));
    });
  }

  function clearHoveredTile() {
    if (hoverFrameRef.current !== null) window.cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = null;
    hoverPointRef.current = null;
    setHoveredTile(null);
  }

  async function shuffleWall() {
    if (shufflingRef.current || selected) return;
    shufflingRef.current = true;
    const wall = wallRef.current;
    if (wall && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const fade = wall.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "linear", fill: "forwards" });
      await fade.finished.catch(() => undefined);
    }
    onShuffle();
    shufflingRef.current = false;
  }

  function changePreviewMode(mode: PreviewMode) {
    if (mode === previewMode) return;
    setWalletPayment(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !document.startViewTransition) {
      setPreviewMode(mode);
      return;
    }
    document.startViewTransition(() => flushSync(() => setPreviewMode(mode)));
  }

  async function closePreview() {
    if (previewClosingRef.current || !selectedCard) return;
    previewClosingRef.current = true;
    flightRef.current?.parentElement?.remove();
    const target = getZoomSourceRect();
    const source = sourceTileRef.current?.getBoundingClientRect();
    const backdrop = modalRef.current?.parentElement;
    if (source && target && backdrop && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (modalRef.current) modalRef.current.dataset.closing = "true";
      const fade = backdrop.animate([{ opacity: 1 }, { opacity: 1, offset: .18 }, { opacity: 0 }], { duration: 500, easing: "cubic-bezier(.33,1,.68,1)", fill: "forwards" });
      await Promise.allSettled([flyCard(source, target, selectedCard.image, true), fade.finished]);
    }
    restoreSourceTile();
    setSelected(null);
    previewClosingRef.current = false;
  }

  const drawPosition = () => {
    const viewport = viewportRef.current;
    const wall = wallRef.current;
    if (!viewport || !wall) return;
    const position = positionRef.current;
    const maxX = Math.max(0, (wall.offsetWidth * position.scale - viewport.clientWidth) / 2 + 90);
    const maxY = Math.max(0, (wall.offsetHeight * position.scale - viewport.clientHeight) / 2 + 90);
    position.x = Math.max(-maxX, Math.min(maxX, position.x));
    position.y = Math.max(-maxY, Math.min(maxY, position.y));
    wall.style.transform = `translate(-50%, -50%) rotateX(15deg) rotateZ(-6deg) scale(${position.scale}) translate3d(${position.x}px, ${position.y}px, 0)`;
  };

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (zoomOpen) void closeZoom();
        else if (selected) void closePreview();
        else onClose();
        return;
      }
      if (zoomOpen && event.key === "Tab") {
        event.preventDefault();
        zoomCloseRef.current?.focus();
        return;
      }
      if (selected && event.key === "Tab") {
        const focusables = [...(modalRef.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? [])];
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!modalRef.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        return;
      }
      if (selected || event.altKey || event.metaKey || event.ctrlKey) return;
      const step = event.shiftKey ? 180 : 85;
      if (event.key === "ArrowLeft") positionRef.current.x += step;
      else if (event.key === "ArrowRight") positionRef.current.x -= step;
      else if (event.key === "ArrowUp") positionRef.current.y += step;
      else if (event.key === "ArrowDown") positionRef.current.y -= step;
      else if (event.key === "+" || event.key === "=") positionRef.current.scale = Math.min(MAX_SCALE, positionRef.current.scale + 0.1);
      else if (event.key === "-" || event.key === "_") positionRef.current.scale = Math.max(MIN_SCALE, positionRef.current.scale - 0.1);
      else return;
      event.preventDefault();
      drawPosition();
      // 手动浏览后从当前位置继续漫游，不能被旧漂移范围拉回去。
      driftAnchorRef.current = { x: positionRef.current.x, y: positionRef.current.y };
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", drawPosition);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", drawPosition);
    };
  }, [onClose, selected, zoomOpen]);

  useEffect(() => {
    positionRef.current = newPosition();
    driftDirectionRef.current = { x: -1, y: -1, angle: 0.04 };
    driftAnchorRef.current = { x: 0, y: 0 };
    restoreSourceTile();
    setSelected(null);
    setZoomOpen(false);
    drawPosition();
  }, [seed]);

  useEffect(() => {
    if (selected || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let previousTime = 0;
    const animate = (time: number) => {
      const elapsed = previousTime ? Math.min((time - previousTime) / 1000, 0.05) : 0;
      previousTime = time;
      const viewport = viewportRef.current;
      const wall = wallRef.current;
      if (!selected && !dragRef.current && !document.hidden && viewport && wall && elapsed) {
        const position = positionRef.current;
        const direction = driftDirectionRef.current;
        const maxX = Math.max(0, (wall.offsetWidth * position.scale - viewport.clientWidth) / 2 + 90);
        const maxY = Math.max(0, (wall.offsetHeight * position.scale - viewport.clientHeight) / 2 + 90);
        direction.angle = Math.min(0.22, direction.angle + DRIFT_ANGLE_PER_SECOND * elapsed);
        position.x += direction.x * Math.cos(direction.angle) * DRIFT_SPEED_PER_SECOND * elapsed;
        position.y += direction.y * Math.sin(direction.angle) * DRIFT_SPEED_PER_SECOND * elapsed;
        const anchor = driftAnchorRef.current;
        const minX = Math.max(-maxX, anchor.x - DRIFT_TRAVEL_X);
        const maxDriftX = Math.min(maxX, anchor.x + DRIFT_TRAVEL_X);
        const minY = Math.max(-maxY, anchor.y - DRIFT_TRAVEL_Y);
        const maxDriftY = Math.min(maxY, anchor.y + DRIFT_TRAVEL_Y);
        if (position.x <= minX || position.x >= maxDriftX) { position.x = Math.max(minX, Math.min(maxDriftX, position.x)); direction.x *= -1; }
        if (position.y <= minY || position.y >= maxDriftY) { position.y = Math.max(minY, Math.min(maxDriftY, position.y)); direction.y *= -1; }
        drawPosition();
      }
      frame = window.requestAnimationFrame(animate);
    };
    const syncVisibility = () => {
      window.cancelAnimationFrame(frame);
      previousTime = 0;
      if (!document.hidden) frame = window.requestAnimationFrame(animate);
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalCloseRef.current?.focus();
    return () => previous?.focus();
  }, [selected]);

  useLayoutEffect(() => {
    if (!selectedCard || !sourceTileRef.current || !zoomSourceRef.current || !modalRef.current) return;
    const from = sourceTileRef.current.getBoundingClientRect();
    const to = zoomSourceRef.current.getBoundingClientRect();
    sourceTileRef.current.style.visibility = "hidden";
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      modalRef.current.dataset.revealed = "true";
      modalRef.current.dataset.landed = "true";
      return;
    }
    let alive = true;
    const revealTimer = window.setTimeout(() => {
      if (alive && !previewClosingRef.current && modalRef.current) modalRef.current.dataset.revealed = "true";
    }, 250);
    void flyCard(from, to, selectedCard.image);
    return () => { alive = false; window.clearTimeout(revealTimer); };
  }, [selected?.key]);

  useEffect(() => () => {
    restoreSourceTile();
    tileObserverRef.current?.disconnect();
    tileNearCallbacksRef.current.clear();
    if (hoverFrameRef.current !== null) window.cancelAnimationFrame(hoverFrameRef.current);
    if (effectFrameRef.current !== null) window.cancelAnimationFrame(effectFrameRef.current);
  }, []);

  useEffect(() => {
    if (previewMode === "showcase") return;
    if (effectFrameRef.current !== null) window.cancelAnimationFrame(effectFrameRef.current);
    effectFrameRef.current = null;
    effectPointRef.current = null;
    effectRectRef.current = null;
  }, [previewMode]);

  useLayoutEffect(() => {
    if (previewMode !== "actual" || !selectedCard) return;
    const region = actualRef.current;
    if (!region) return;
    region.scrollLeft = Math.max(0, (region.scrollWidth - region.clientWidth) / 2);
    region.scrollTop = Math.max(0, (region.scrollHeight - region.clientHeight) / 2);
  }, [previewMode, selectedCard?.key]);

  useLayoutEffect(() => {
    if (!zoomOpen) return;
    const source = getZoomSourceRect();
    const target = zoomImageRef.current?.getBoundingClientRect();
    if (source && target && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const x = source.left + source.width / 2 - target.left - target.width / 2;
      const y = source.top + source.height / 2 - target.top - target.height / 2;
      zoomImageRef.current?.animate([
        { transform: `translate(${x}px, ${y}px) scale(${source.width / target.width})`, borderRadius: "17px" },
        { transform: "none", borderRadius: "22px" }
      ], { duration: 460, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" });
    }
    zoomCloseRef.current?.focus();
    return () => zoomSourceRef.current?.focus();
  }, [zoomOpen]);

  function getZoomSourceRect() {
    const source = zoomSourceRef.current?.getBoundingClientRect();
    if (!source || previewMode !== "actual" || !actualRef.current) return source;
    const viewport = actualRef.current.getBoundingClientRect();
    const left = Math.max(source.left, viewport.left);
    const top = Math.max(source.top, viewport.top);
    return { left, top, width: Math.max(1, Math.min(source.right, viewport.right) - left), height: Math.max(1, Math.min(source.bottom, viewport.bottom) - top) };
  }

  function openZoom() {
    if (!zoomEffectBagRef.current.length) {
      const bag = PREVIEW_EFFECTS.map((effect) => effect.key);
      for (let index = bag.length - 1; index > 0; index--) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [bag[index], bag[randomIndex]] = [bag[randomIndex], bag[index]];
      }
      if (bag[bag.length - 1] === previousZoomEffectRef.current) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      zoomEffectBagRef.current = bag;
    }
    const effect = zoomEffectBagRef.current.pop()!;
    previousZoomEffectRef.current = effect;
    setZoomEffect(effect);
    setZoomOpen(true);
  }

  async function closeZoom() {
    if (zoomClosingRef.current) return;
    const source = getZoomSourceRect();
    const target = zoomImageRef.current?.getBoundingClientRect();
    const backdrop = zoomRef.current;
    const image = zoomImageRef.current;
    if (!source || !target || !backdrop || !image || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setZoomOpen(false);
      return;
    }
    zoomClosingRef.current = true;
    image.getAnimations().forEach((animation) => animation.cancel());
    const x = source.left + source.width / 2 - target.left - target.width / 2;
    const y = source.top + source.height / 2 - target.top - target.height / 2;
    const shrink = image.animate([
      { transform: "none", borderRadius: "22px" },
      { transform: `translate(${x}px, ${y}px) scale(${source.width / target.width})`, borderRadius: "17px" }
    ], { duration: 360, easing: "cubic-bezier(.3,0,.8,.2)", fill: "forwards" });
    const fade = backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: "ease-in", fill: "forwards" });
    await Promise.allSettled([shrink.finished, fade.finished]);
    zoomClosingRef.current = false;
    setZoomOpen(false);
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (selected || event.button !== 0) return;
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: positionRef.current.x, originY: positionRef.current.y, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) {
      if (!selected && event.pointerType === "mouse") {
        const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".card-wander-tile") : null;
        queueHoveredTile(event.clientX, event.clientY, target);
      }
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 6) {
      drag.moved = true;
      clearHoveredTile();
      event.currentTarget.dataset.dragging = "true";
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (!drag.moved) return;
    positionRef.current.x = drag.originX + dx;
    positionRef.current.y = drag.originY + dy;
    drawPosition();
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== event.pointerId) return;
    suppressClickRef.current = dragRef.current.moved;
    dragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    driftAnchorRef.current = { x: positionRef.current.x, y: positionRef.current.y };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (selected) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      positionRef.current.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, positionRef.current.scale - event.deltaY * 0.002));
    } else {
      positionRef.current.x -= event.deltaX;
      positionRef.current.y -= event.deltaY;
    }
    drawPosition();
    driftAnchorRef.current = { x: positionRef.current.x, y: positionRef.current.y };
  };
  const onEffectPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!modalRef.current?.hasAttribute("data-landed") || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = effectRectRef.current ?? event.currentTarget.getBoundingClientRect();
    effectRectRef.current = rect;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    effectPointRef.current = { x, y, width: rect.width, height: rect.height };
    event.currentTarget.dataset.pointerActive = "true";
    if (effectFrameRef.current !== null) return;
    effectFrameRef.current = window.requestAnimationFrame(() => {
      effectFrameRef.current = null;
      const point = effectPointRef.current;
      if (!point) return;
      const { x, y, width, height } = point;
      if (effectTiltRef.current) effectTiltRef.current.style.transform = `rotateX(${((0.5 - y) * 12).toFixed(2)}deg) rotateY(${((x - 0.5) * 13).toFixed(2)}deg)`;
      const reflection = `translate3d(${((x - 0.5) * width).toFixed(1)}px, ${((y - 0.5) * height).toFixed(1)}px, 0)`;
      if (effectGlareRef.current) effectGlareRef.current.style.transform = reflection;
      if (effectSpecRef.current) effectSpecRef.current.style.transform = reflection;
    });
  };
  const onEffectPointerLeave = (event: PointerEvent<HTMLButtonElement>) => {
    if (effectFrameRef.current !== null) window.cancelAnimationFrame(effectFrameRef.current);
    effectFrameRef.current = null;
    effectPointRef.current = null;
    effectRectRef.current = null;
    delete event.currentTarget.dataset.pointerActive;
    if (effectTiltRef.current) effectTiltRef.current.style.transform = "";
    if (effectGlareRef.current) effectGlareRef.current.style.transform = "";
    if (effectSpecRef.current) effectSpecRef.current.style.transform = "";
  };

  return (
    <div className="card-wander" role="dialog" aria-modal="true" aria-label="卡面漫游">
      <div
        ref={viewportRef}
        className="card-wander-viewport"
        aria-label="卡面墙：拖动或使用方向键浏览，按加减号缩放，点按卡面查看"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onPointerLeave={(event) => {
          clearHoveredTile();
          // 尚未达到拖动阈值时没有 capture，离开视口也必须结束按压。
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) onPointerUp(event);
        }}
        onWheel={onWheel}
        onClickCapture={(event) => {
          if (!suppressClickRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          suppressClickRef.current = false;
        }}
        onClick={(event) => {
          if (selected || event.target instanceof Element && event.target.closest(".card-wander-tile")) return;
          const tile = findTileAtPoint(event.clientX, event.clientY);
          const card = tile && deck.find((item) => item.key === tile.dataset.wanderKey);
          if (tile && card) selectTile(card, tile);
        }}
      >
        <div className="card-wander-world">
          <div ref={wallRef} key={seed} className="card-wander-wall">
            {columns.map((column, columnIndex) => (
              <div key={columnIndex} className="card-wander-column" style={{ "--wander-column-stagger": columnIndex % 2 } as CSSProperties}>
                {column.map((card) => (
                  <WanderTile
                    key={card.key}
                    card={card}
                    observeTile={observeTile}
                    onSelect={selectTile}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="card-wander-vignette" aria-hidden="true" />
      <div className="card-wander-topbar">
        <button ref={closeRef} type="button" className="card-wander-pill" onClick={onClose} aria-label="返回卡面库">
          <span aria-hidden="true">←</span> 返回
        </button>
      </div>
      <button type="button" className="card-wander-shuffle" onClick={() => void shuffleWall()} aria-label="洗牌，浏览另一组卡面">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h3c4 0 5 10 10 10h3m-3-3 3 3-3 3M4 17h3c1.5 0 2.5-.8 3.3-2M14 9c.8-1.2 1.7-2 3-2h3m-3-3 3 3-3 3" /></svg>
        洗牌
      </button>
      {selectedCard && (
        <div className="card-wander-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) void closePreview(); }}>
          <div ref={modalRef} className="card-wander-modal" role="dialog" aria-modal="true" aria-labelledby="card-wander-modal-title">
            <div className="card-wander-preview-stage" data-mode={previewMode} data-effect={previewEffect}>
            {previewMode === "showcase" && <button ref={zoomSourceRef} type="button" className="card-wander-effect" data-effect={previewEffect} aria-label={`放大查看 ${selectedCard.name} 原图`} onPointerEnter={(event) => { effectRectRef.current = event.currentTarget.getBoundingClientRect(); }} onPointerDown={(event) => { effectPressRef.current = { x: event.clientX, y: event.clientY, moved: false }; }} onPointerMove={(event) => {
              onEffectPointerMove(event);
              const press = effectPressRef.current;
              if (press && Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y) > 8) press.moved = true;
            }} onPointerUp={() => { window.setTimeout(() => { effectPressRef.current = null; }, 0); }} onPointerLeave={onEffectPointerLeave} onClick={() => {
              if (effectPressRef.current?.moved) return;
              openZoom();
            }}>
              <div ref={effectTiltRef} className="card-wander-effect-tilt">
                <img className="card-wander-modal-image" src={selectedCard.image} alt={selectedCard.name} draggable={false} />
                <span className="card-wander-effect-sheen" aria-hidden="true" />
                <span ref={effectGlareRef} className="card-wander-effect-glare" aria-hidden="true" />
                <span ref={effectSpecRef} className="card-wander-effect-spec" aria-hidden="true" />
              </div>
            </button>}
            {previewMode === "wallet" && <div className="card-wander-wallet" data-payment={walletPayment}>
              <div className="card-wander-wallet-island" aria-hidden="true"><span className="card-wander-wallet-face">◉</span></div>
              <div className="card-wander-wallet-status" aria-hidden="true"><span>9:41</span><span>●●● ▰</span></div>
              <div className="card-wander-wallet-header" aria-hidden="true"><strong>钱包</strong><span>＋　···</span></div>
              <div className="card-wander-wallet-payment-header" aria-hidden="true"><span>×</span><span>···</span></div>
              <div className="card-wander-wallet-stack" aria-hidden="true"><span /><span /><span /></div>
              <button ref={zoomSourceRef} type="button" className="card-wander-wallet-card" aria-label={`模拟刷卡：${selectedCard.name}`} aria-pressed={walletPayment} onClick={() => setWalletPayment((open) => !open)}>
                <img src={selectedCard.image} alt={selectedCard.name} draggable={false} />
                <span className="card-wander-effect-sheen" aria-hidden="true" />
              </button>
              <div className="card-wander-wallet-hint" aria-hidden="true">轻点卡面，试试刷卡</div>
              <div className="card-wander-wallet-reader" aria-hidden="true"><span className="card-wander-wallet-reader-ring">▯</span><span>靠近读卡器</span></div>
              <div className="card-wander-wallet-bottom" aria-hidden="true"><span>◉</span><span>⌂</span></div>
            </div>}
            {previewMode === "actual" && <div ref={actualRef} className="card-wander-actual" role="region" aria-label="原尺寸卡面，可拖动或滚动查看" onPointerDown={(event) => {
              if (event.button !== 0) return;
              actualDragRef.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop, moved: false };
            }} onPointerMove={(event) => {
              const drag = actualDragRef.current;
              if (!drag) return;
              const dx = event.clientX - drag.x;
              const dy = event.clientY - drag.y;
              if (Math.abs(dx) + Math.abs(dy) > 6) { drag.moved = true; event.currentTarget.setPointerCapture(event.pointerId); }
              if (!drag.moved) return;
              event.currentTarget.scrollLeft = drag.left - dx;
              event.currentTarget.scrollTop = drag.top - dy;
            }} onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              window.setTimeout(() => { actualDragRef.current = null; }, 0);
            }} onPointerCancel={() => { actualDragRef.current = null; }}>
              <button ref={zoomSourceRef} type="button" className="card-wander-actual-card" aria-label={`放大查看 ${selectedCard.name} 原图`} onClick={() => { if (!actualDragRef.current?.moved) openZoom(); }}>
                <img src={selectedCard.image} alt={selectedCard.name} draggable={false} onLoad={() => {
                  const region = actualRef.current;
                  if (!region) return;
                  region.scrollLeft = Math.max(0, (region.scrollWidth - region.clientWidth) / 2);
                  region.scrollTop = Math.max(0, (region.scrollHeight - region.clientHeight) / 2);
                }} />
                <span className="card-wander-effect-sheen" aria-hidden="true" />
              </button>
            </div>}
            {previewMode === "actual" && <span className="card-wander-actual-hint" aria-hidden="true">拖动或滚动查看全图</span>}
            </div>
            <div className="card-wander-preview-controls">
            <div className="card-wander-modes" role="radiogroup" aria-label="卡面展示方式" style={{ "--segment-index": PREVIEW_MODES.findIndex((item) => item.key === previewMode) } as CSSProperties} onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const current = PREVIEW_MODES.findIndex((item) => item.key === previewMode);
              const next = (current + (event.key === "ArrowRight" ? 1 : PREVIEW_MODES.length - 1)) % PREVIEW_MODES.length;
              changePreviewMode(PREVIEW_MODES[next].key);
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
            }}>
              <span className="card-wander-seg-thumb" aria-hidden="true" />
              {PREVIEW_MODES.map(({ key, label }) => (
                <button key={key} type="button" role="radio" aria-checked={previewMode === key} tabIndex={previewMode === key ? 0 : -1} onClick={() => changePreviewMode(key)}>{label}</button>
              ))}
            </div>
            {previewMode === "showcase" && <div className="card-wander-effects" role="radiogroup" aria-label="卡面光效" style={{ "--segment-index": PREVIEW_EFFECTS.findIndex((item) => item.key === previewEffect) } as CSSProperties} onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const current = PREVIEW_EFFECTS.findIndex((item) => item.key === previewEffect);
              const next = (current + (event.key === "ArrowRight" ? 1 : PREVIEW_EFFECTS.length - 1)) % PREVIEW_EFFECTS.length;
              setPreviewEffect(PREVIEW_EFFECTS[next].key);
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
            }}>
              <span className="card-wander-seg-thumb" aria-hidden="true" />
              {PREVIEW_EFFECTS.map(({ key, label }) => (
                <button key={key} type="button" role="radio" aria-checked={previewEffect === key} tabIndex={previewEffect === key ? 0 : -1} onClick={() => setPreviewEffect(key)}>{label}</button>
              ))}
            </div>}
            </div>
            <div className="card-wander-modal-content">
              <div className="card-wander-modal-heading">
                <div className="min-w-0">
                  <h3 id="card-wander-modal-title" className="truncate text-[15px] font-semibold">{selectedCard.name}</h3>
                  <p className="mt-1 truncate text-xs text-white/50">{selectedCard.bank} · {selectedCard.region}{selectedCard.type ? ` · ${selectedCard.type}` : ""}</p>
                </div>
                <button ref={modalCloseRef} type="button" className="card-wander-modal-close" onClick={() => void closePreview()} aria-label="关闭卡面预览">×</button>
              </div>
              <div className="card-wander-modal-actions">
                <button type="button" className="card-wander-hold" onClick={() => onToggleHeld(selectedCard.key, !selectedCard.held)} aria-label={selectedCard.held ? "移出我的卡" : "加入我的卡"} title={selectedCard.held ? "移出我的卡" : "加入我的卡"}>
                  <span aria-hidden="true">{selectedCard.held ? "♥" : "♡"}</span>{selectedCard.held ? " 已存" : ""}
                </button>
                <a className="card-wander-download" href={selectedCard.image} download aria-label={`下载 ${selectedCard.name} 卡面`}>↓ 下载</a>
                <button type="button" onClick={() => onOpenDetails(selectedCard.key)}>查看详情</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {zoomOpen && selectedCard && (
        <div ref={zoomRef} className="card-wander-zoom-backdrop" role="dialog" aria-modal="true" aria-label={`放大查看 ${selectedCard.name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) void closeZoom(); }}>
          <div ref={zoomImageRef} className="card-wander-zoom-card" data-effect={zoomEffect}>
            <img className="card-wander-zoom-image" src={selectedCard.image} alt={selectedCard.name} draggable={false} />
            <span className="card-wander-effect-sheen" aria-hidden="true" />
          </div>
          <button ref={zoomCloseRef} type="button" className="card-wander-zoom-close" onClick={() => void closeZoom()}><span aria-hidden="true">×</span> 关闭</button>
        </div>
      )}
    </div>
  );
}
