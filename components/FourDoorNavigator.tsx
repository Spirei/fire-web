"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createFourDoorAudio, easeLong, easeShort, LONG_EASE, LONG_TURN_MS, SHORT_EASE, SHORT_TURN_MS, TICK_DEG } from "@/lib/fourDoor";
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

function canonicalAngle(index: number) {
  return -((index % 4 + 4) % 4) * 90;
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
  randomKeys = [],
  pinned = false,
  onTogglePinned
}: {
  activeKey: string;
  onSelect: (key: string) => void;
  randomKeys?: string[];
  pinned?: boolean;
  onTogglePinned?: () => void;
}) {
  const uid = useId().replace(/:/g, "");
  const initialIndex = Math.max(0, DOORS.findIndex((door) => door.key === activeKey));
  const currentIndex = useRef(initialIndex);
  const rotationRef = useRef(canonicalAngle(initialIndex));
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<ReturnType<typeof createFourDoorAudio> | null>(null);
  const watchRef = useRef<number | null>(null);
  const doneTimer = useRef<number | null>(null);
  const spinJob = useRef<{ from: number; to: number; start: number; duration: number; ease: (t: number) => number } | null>(null);
  const [rotation, setRotation] = useState(canonicalAngle(initialIndex));
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

  function visualAngle() {
    const job = spinJob.current;
    if (!job) return rotationRef.current;
    const t = Math.min(1, (performance.now() - job.start) / job.duration);
    return job.from + (job.to - job.from) * job.ease(t);
  }

  function settle(index: number) {
    const canon = canonicalAngle(index);
    const el = wheelRef.current;
    spinJob.current = null;
    rotationRef.current = canon;
    if (el) {
      el.style.transition = "none";
      el.style.transform = `rotate(${canon}deg)`;
    }
    setRotation(canon);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (wheelRef.current) wheelRef.current.style.transition = "";
      });
    });
  }

  function watchSpin(fromAngle: number, toAngle: number, durationMs: number, ease: (t: number) => number, withSound: boolean) {
    if (watchRef.current !== null) window.cancelAnimationFrame(watchRef.current);
    let lastNotch = Math.floor(fromAngle / TICK_DEG);
    let lastAngle = fromAngle;
    let lastTime = performance.now();
    const start = lastTime;
    const delta = toAngle - fromAngle;
    const voice = doorStyle;
    if (withSound && soundOn) audio().begin(voice);
    const loop = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const angle = fromAngle + delta * ease(t);
      const dt = Math.max(0.001, (now - lastTime) / 1000);
      const velocity = Math.abs(angle - lastAngle) / dt;
      lastTime = now;
      lastAngle = angle;
      const notch = Math.floor(angle / TICK_DEG);
      if (notch !== lastNotch) {
        lastNotch = notch;
        if (withSound && soundOn) audio().tick(velocity, voice);
      }
      if (t < 1) {
        watchRef.current = window.requestAnimationFrame(loop);
        return;
      }
      watchRef.current = null;
      if (withSound && soundOn) audio().lock(voice);
    };
    watchRef.current = window.requestAnimationFrame(loop);
  }

  function spinTo(index: number, extraTurns: number, duration: number, easeName: string, ease: (t: number) => number, withSound: boolean, navigate: boolean) {
    const from = visualAngle();
    const step = extraTurns === 0 ? shortestStep(currentIndex.current, index) : ((index - currentIndex.current + 4) % 4 || 4);
    if (extraTurns === 0 && step === 0) return;
    const to = from - extraTurns * 360 - step * 90;
    currentIndex.current = index;
    spinJob.current = { from, to, start: performance.now(), duration, ease };
    rotationRef.current = to;
    const el = wheelRef.current;
    if (el) {
      el.style.transition = "none";
      el.style.transform = `rotate(${from}deg)`;
      void el.offsetWidth;
      el.style.transition = `transform ${duration}ms ${easeName}`;
      el.style.transform = `rotate(${to}deg)`;
    }
    setRotation(to);
    watchSpin(from, to, duration, ease, withSound);
    if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
    doneTimer.current = window.setTimeout(() => {
      doneTimer.current = null;
      settle(index);
      setRandomizing(false);
      if (navigate) onSelect(DOORS[index].key);
    }, duration + 32);
  }

  function moveTo(index: number, navigate: boolean) {
    if (randomizing) return;
    spinTo(index, 0, SHORT_TURN_MS, SHORT_EASE, easeShort, navigate, navigate);
  }

  function spinToRandomWorkspace() {
    if (randomizing) return;
    const candidates = randomKeys.filter((key) => key !== activeKey);
    if (!candidates.length) return;
    const random = crypto.getRandomValues(new Uint32Array(1));
    const destination = candidates[random[0] % candidates.length];
    const destIndex = Math.max(0, DOORS.findIndex((door) => door.key === destination));
    setRandomizing(true);
    spinTo(destIndex, 2, LONG_TURN_MS, LONG_EASE, easeLong, true, true);
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
    if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
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
      <div className={`four-door-art ${randomizing ? "is-randomizing" : ""} ${styleTwo ? "is-style-2" : "is-style-1"}`} aria-busy={randomizing}>
        <img onError={() => setArtAvailable(false)} className="four-door-window" src="/uploads/feature/four-door/window.png" alt="霍尔的移动城堡窗户" />
        <div
          ref={wheelRef}
          className="four-door-wheel"
          style={{ transform: `rotate(${rotation}deg)` }}
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
      {onTogglePinned && <button type="button" className={`four-door-pin ${pinned ? "is-pinned" : ""}`} aria-label={pinned ? "取消固定四色门" : "固定四色门"} aria-pressed={pinned} title={pinned ? "取消固定四色门" : "固定四色门"} onClick={onTogglePinned}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3h8l-1 6 3 3v2H6v-2l3-3-1-6Z" /><path d="M12 14v7" /></svg>
      </button>}
    </div>
  );
}
