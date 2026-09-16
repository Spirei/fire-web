"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createFourDoorAudio, LONG_EASE, LONG_TURN_MS, SHORT_EASE, SHORT_TURN_MS, TICK_DEG } from "@/lib/fourDoor";
import { usePersistedState } from "@/lib/usePersistedState";

export type FourDoorKey = "holdings" | "assets" | "fire" | "global";
type DoorStyle = 1 | 2;

const DOORS: Array<{ key: FourDoorKey; label: string; color: string }> = [
  { key: "holdings", label: "账户资产", color: "blue" },
  { key: "assets", label: "资产分析", color: "charcoal" },
  { key: "fire", label: "FIRE", color: "ember" },
  { key: "global", label: "全球经济", color: "moss" }
];

function shortestStep(from: number, to: number) {
  return ((to - from + 2) % 4) - 2;
}

function polar(radius: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return [100 + radius * Math.sin(rad), 100 - radius * Math.cos(rad)] as const;
}

function sectorPath(startDeg: number, endDeg: number, inner: number, outer: number) {
  const [x0, y0] = polar(outer, startDeg);
  const [x1, y1] = polar(outer, endDeg);
  const [x2, y2] = polar(inner, endDeg);
  const [x3, y3] = polar(inner, startDeg);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${outer},${outer} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${inner},${inner} 0 0 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`;
}

function readMatrixAngle(el: HTMLElement) {
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === "none") return 0;
  const matrix = new DOMMatrixReadOnly(transform);
  return Math.atan2(matrix.b, matrix.a) * (180 / Math.PI);
}

function unwrapAngle(previous: number, sampled: number) {
  const wrapped = ((previous + 180) % 360 + 360) % 360 - 180;
  let delta = sampled - wrapped;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return previous + delta;
}

function FourDoorDial({ uid }: { uid: string }) {
  const blue = `fd-${uid}-blue`;
  const charcoal = `fd-${uid}-charcoal`;
  const ember = `fd-${uid}-ember`;
  const moss = `fd-${uid}-moss`;
  const rim = `fd-${uid}-rim`;
  const gloss = `fd-${uid}-gloss`;
  const arrow = `fd-${uid}-arrow`;
  return (
    <svg className="four-door-dial" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <radialGradient id={blue} cx="42%" cy="32%" r="78%">
          <stop offset="0%" stopColor="#5ec4ff" />
          <stop offset="46%" stopColor="#1f86e6" />
          <stop offset="100%" stopColor="#0d5fb8" />
        </radialGradient>
        <radialGradient id={charcoal} cx="62%" cy="38%" r="80%">
          <stop offset="0%" stopColor="#4a4e55" />
          <stop offset="52%" stopColor="#1c1f24" />
          <stop offset="100%" stopColor="#0b0c0e" />
        </radialGradient>
        <radialGradient id={ember} cx="48%" cy="68%" r="78%">
          <stop offset="0%" stopColor="#ff6d5c" />
          <stop offset="48%" stopColor="#ee3a2f" />
          <stop offset="100%" stopColor="#b51b16" />
        </radialGradient>
        <radialGradient id={moss} cx="32%" cy="58%" r="78%">
          <stop offset="0%" stopColor="#8ae05a" />
          <stop offset="48%" stopColor="#4cbf34" />
          <stop offset="100%" stopColor="#278a1f" />
        </radialGradient>
        <linearGradient id={rim} x1="20%" y1="8%" x2="80%" y2="92%">
          <stop offset="0%" stopColor="#f4e2a4" />
          <stop offset="42%" stopColor="#c9a24a" />
          <stop offset="100%" stopColor="#7a5a1c" />
        </linearGradient>
        <radialGradient id={gloss} cx="34%" cy="28%" r="62%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.38" />
          <stop offset="38%" stopColor="#fff" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <marker id={arrow} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="5.8" markerHeight="5.8" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0.6 1.2 11.4 6 0.6 10.8Z" fill="#fff" />
        </marker>
      </defs>
      <circle cx="100" cy="100" r="99" fill={`url(#${rim})`} />
      <circle cx="100" cy="100" r="93.5" fill="#1a1308" />
      <path d={sectorPath(-45, 45, 16, 92)} fill={`url(#${blue})`} />
      <path d={sectorPath(45, 135, 16, 92)} fill={`url(#${charcoal})`} />
      <path d={sectorPath(135, 225, 16, 92)} fill={`url(#${ember})`} />
      <path d={sectorPath(225, 315, 16, 92)} fill={`url(#${moss})`} />
      {[-45, 45, 135, 225].map((deg) => {
        const [x1, y1] = polar(16, deg);
        const [x2, y2] = polar(92, deg);
        return <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,.22)" strokeWidth="1.2" />;
      })}
      <ellipse cx="78" cy="72" rx="46" ry="28" fill={`url(#${gloss})`} transform="rotate(-28 78 72)" />
      <path
        d="M131 158 C 117 176 86 176 74 159"
        fill="none"
        stroke="#fff"
        strokeWidth="3.8"
        strokeLinecap="round"
        markerEnd={`url(#${arrow})`}
      />
    </svg>
  );
}

export default function FourDoorNavigator({
  activeKey,
  onSelect,
  randomKeys = []
}: {
  activeKey: string;
  onSelect: (key: string) => void;
  randomKeys?: string[];
}) {
  const uid = useId().replace(/:/g, "");
  const initialIndex = Math.max(0, DOORS.findIndex((door) => door.key === activeKey));
  const currentIndex = useRef(initialIndex);
  const rotationRef = useRef(-initialIndex * 90);
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<ReturnType<typeof createFourDoorAudio> | null>(null);
  const watchRef = useRef<number | null>(null);
  const navigationTimer = useRef<number | null>(null);
  const pointerTimer = useRef<number | null>(null);
  const turningTimer = useRef<number | null>(null);
  const [rotation, setRotation] = useState(-initialIndex * 90);
  const [turning, setTurning] = useState(false);
  const [randomizing, setRandomizing] = useState(false);
  const [artAvailable, setArtAvailable] = useState(true);
  const [soundOn, setSoundOn] = usePersistedState("fire:four-door-sound", true);
  const [doorStyle, setDoorStyle] = usePersistedState<DoorStyle>("fire:four-door-style", 1);

  function audio() {
    audioRef.current ??= createFourDoorAudio();
    return audioRef.current;
  }

  function stopAllSound() {
    audioRef.current?.stop();
    audioRef.current = null;
  }

  function watchSpin(fromAngle: number, durationMs: number, withSound: boolean) {
    const el = wheelRef.current;
    if (!el) return;
    if (watchRef.current !== null) window.cancelAnimationFrame(watchRef.current);
    let unwrapped = fromAngle;
    let lastAngle = fromAngle;
    let lastNotch = Math.floor(fromAngle / TICK_DEG);
    let lastTime = performance.now();
    const start = lastTime;
    const loop = (now: number) => {
      unwrapped = unwrapAngle(unwrapped, readMatrixAngle(el));
      const dt = Math.max(0.001, (now - lastTime) / 1000);
      const velocity = Math.abs(unwrapped - lastAngle) / dt;
      lastTime = now;
      lastAngle = unwrapped;
      const notch = Math.floor(unwrapped / TICK_DEG);
      if (notch !== lastNotch) {
        const crossed = Math.abs(notch - lastNotch);
        lastNotch = notch;
        if (withSound && soundOn) {
          for (let i = 0; i < crossed; i += 1) audio().tick(velocity);
        }
      }
      if (now - start < durationMs + 36) {
        watchRef.current = window.requestAnimationFrame(loop);
        return;
      }
      watchRef.current = null;
      if (withSound && soundOn) audio().lock();
    };
    watchRef.current = window.requestAnimationFrame(loop);
  }

  function moveTo(index: number, navigate: boolean) {
    if (randomizing) return;
    const step = shortestStep(currentIndex.current, index);
    if (step === 0) return;
    const from = rotationRef.current;
    currentIndex.current = index;
    rotationRef.current = from - step * 90;
    setRotation(rotationRef.current);
    setTurning(false);
    window.requestAnimationFrame(() => setTurning(true));
    if (turningTimer.current !== null) window.clearTimeout(turningTimer.current);
    turningTimer.current = window.setTimeout(() => {
      turningTimer.current = null;
      setTurning(false);
    }, SHORT_TURN_MS);
    if (navigate) {
      watchSpin(from, SHORT_TURN_MS, true);
      onSelect(DOORS[index].key);
    }
  }

  function spinToRandomWorkspace() {
    if (randomizing) return;
    const candidates = randomKeys.filter((key) => key !== activeKey);
    if (!candidates.length) return;
    const random = crypto.getRandomValues(new Uint32Array(2));
    const destination = candidates[random[0] % candidates.length];
    const quarterSteps = (random[1] % 3) + 1;
    const from = rotationRef.current;
    currentIndex.current = (currentIndex.current + quarterSteps) % DOORS.length;
    rotationRef.current = from - (720 + quarterSteps * 90);
    setRandomizing(true);
    setRotation(rotationRef.current);
    setTurning(false);
    if (pointerTimer.current !== null) window.clearTimeout(pointerTimer.current);
    if (turningTimer.current !== null) window.clearTimeout(turningTimer.current);
    pointerTimer.current = window.setTimeout(() => {
      pointerTimer.current = null;
      setTurning(true);
    }, Math.round(LONG_TURN_MS * 0.42));
    turningTimer.current = window.setTimeout(() => {
      turningTimer.current = null;
      setTurning(false);
    }, LONG_TURN_MS + 40);
    watchSpin(from, LONG_TURN_MS, true);
    if (navigationTimer.current !== null) window.clearTimeout(navigationTimer.current);
    navigationTimer.current = window.setTimeout(() => {
      navigationTimer.current = null;
      setRandomizing(false);
      onSelect(destination);
    }, LONG_TURN_MS + 60);
  }

  useEffect(() => {
    const next = DOORS.findIndex((door) => door.key === activeKey);
    if (next >= 0) moveTo(next, false);
    // activeKey is the only external synchronization signal; moveTo remains event-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  useEffect(() => () => {
    stopAllSound();
    if (watchRef.current !== null) window.cancelAnimationFrame(watchRef.current);
    if (navigationTimer.current !== null) window.clearTimeout(navigationTimer.current);
    if (pointerTimer.current !== null) window.clearTimeout(pointerTimer.current);
    if (turningTimer.current !== null) window.clearTimeout(turningTimer.current);
  }, []);

  if (!artAvailable) return null;
  const styleTwo = doorStyle === 2;
  return (
    <div className="four-door-zone">
      <button
        type="button"
        className={`four-door-tool four-door-style ${styleTwo ? "is-style-two" : ""}`}
        aria-pressed={styleTwo}
        aria-label={styleTwo ? "切换到样式 1" : "切换到样式 2"}
        title={styleTwo ? "样式 2，点击切回样式 1" : "样式 1，点击切换到样式 2"}
        onClick={() => setDoorStyle((value) => (value === 2 ? 1 : 2))}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M12 3.2 A8.8 8.8 0 0 1 20.8 12 L12 12 Z" fill="#1f86e6" />
          <path d="M20.8 12 A8.8 8.8 0 0 1 12 20.8 L12 12 Z" fill="#2a2d32" />
          <path d="M12 20.8 A8.8 8.8 0 0 1 3.2 12 L12 12 Z" fill="#ee3a2f" />
          <path d="M3.2 12 A8.8 8.8 0 0 1 12 3.2 L12 12 Z" fill="#4cbf34" />
        </svg>
      </button>
      <button
        type="button"
        className={`four-door-tool four-door-sound ${soundOn ? "is-on" : "is-muted"}`}
        aria-pressed={soundOn}
        aria-label={soundOn ? "关闭四色门音效" : "开启四色门音效"}
        title={soundOn ? "关闭音效" : "开启音效"}
        onClick={() => {
          if (soundOn) stopAllSound();
          setSoundOn((value) => !value);
        }}
      >
        {soundOn ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M11 5 6.8 8.5H3v7h3.8L11 19Z" /><path d="M15 9a4 4 0 0 1 0 6" /><path d="M18 6a8 8 0 0 1 0 12" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6.8 8.5H3v7h3.8L11 19Z" /><path d="m15.5 9.5 5 5m0-5-5 5" /></svg>
        )}
      </button>
      <div className={`four-door-art ${turning ? "is-turning" : ""} ${randomizing ? "is-randomizing" : ""} ${styleTwo ? "is-style-2" : "is-style-1"}`} aria-busy={randomizing}>
        <img onError={() => setArtAvailable(false)} className="four-door-window" src="/uploads/feature/four-door/window.png" alt="霍尔的移动城堡窗户" />
        <div
          ref={wheelRef}
          className="four-door-wheel"
          style={{
            transform: `translateZ(0) rotate(${rotation}deg)`,
            transitionDuration: `${randomizing ? LONG_TURN_MS : SHORT_TURN_MS}ms`,
            transitionTimingFunction: randomizing ? LONG_EASE : SHORT_EASE
          }}
          role="group"
          aria-label="四色门工作区入口"
        >
          {styleTwo ? <FourDoorDial uid={uid} /> : <img src="/uploads/feature/four-door/dial.png" alt="" />}
          {DOORS.map((door, index) => <button key={door.key} type="button" disabled={randomizing} className={`four-door-sector ${door.color}`} aria-label={`${door.label}入口`} onClick={() => moveTo(index, true)} />)}
        </div>
        {styleTwo ? <span className="four-door-hub" aria-hidden="true" /> : null}
        {styleTwo ? <span className="four-door-gloss" aria-hidden="true" /> : null}
        <img className="four-door-pointer four-door-pointer-arch" src="/uploads/feature/four-door/pointer.png" alt="" />
        <img className="four-door-pointer four-door-pointer-tip" src="/uploads/feature/four-door/pointer.png" alt="固定指针" />
        <button type="button" disabled={randomizing || randomKeys.filter((key) => key !== activeKey).length === 0} className="four-door-advance" aria-label={randomizing ? "正在随机选择工作区" : "随机前往工作区"} title={randomizing ? "正在选择…" : "随机前往工作区"} onClick={spinToRandomWorkspace} />
        <img className="four-door-hand" src="/uploads/feature/four-door/cursor-hand.png" alt="" aria-hidden="true" />
      </div>
    </div>
  );
}
