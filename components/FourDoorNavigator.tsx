"use client";

import { useEffect, useRef, useState } from "react";
import { usePersistedState } from "@/lib/usePersistedState";

export type FourDoorKey = "holdings" | "assets" | "fire" | "global";

const DOORS: Array<{ key: FourDoorKey; label: string; color: string }> = [
  { key: "holdings", label: "账户资产", color: "blue" },
  { key: "assets", label: "资产分析", color: "charcoal" },
  { key: "fire", label: "FIRE", color: "ember" },
  { key: "global", label: "全球经济", color: "moss" }
];

function shortestStep(from: number, to: number) {
  return ((to - from + 2) % 4) - 2;
}

export default function FourDoorNavigator({
  activeKey,
  onSelect
}: {
  activeKey: string;
  onSelect: (key: FourDoorKey) => void;
}) {
  const initialIndex = Math.max(0, DOORS.findIndex((door) => door.key === activeKey));
  const currentIndex = useRef(initialIndex);
  const audioContext = useRef<AudioContext | null>(null);
  const [rotation, setRotation] = useState(-initialIndex * 90);
  const [turning, setTurning] = useState(false);
  const [soundOn, setSoundOn] = usePersistedState("fire:four-door-sound", true);

  function stopAllSound() {
    const context = audioContext.current;
    audioContext.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }

  function playTurn(steps: number) {
    if (!soundOn) return;
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = audioContext.current ?? new AudioContextClass();
    audioContext.current = context;
    const ticks = Math.abs(steps) === 2 ? 6 : 4;
    const start = context.currentTime;
    const lockAt = start + 0.13 + ticks * 0.095;
    const master = context.createGain();
    const compressor = context.createDynamicsCompressor();
    master.gain.value = 0.88;
    compressor.threshold.value = -16;
    compressor.knee.value = 5;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.001;
    compressor.release.value = 0.08;
    master.connect(compressor).connect(context.destination);

    for (let index = 0; index < ticks; index += 1) {
      const at = start + 0.13 + index * 0.095;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const filter = context.createBiquadFilter();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(690 - index * 18, at);
      oscillator.frequency.exponentialRampToValueAtTime(410 - index * 10, at + 0.032);
      filter.type = "highpass";
      filter.frequency.value = 360;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.055, at + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
      oscillator.connect(filter).connect(gain).connect(master);
      oscillator.start(at);
      oscillator.stop(at + 0.045);
    }

    ([
      [1567.98, 0.22, 0.18],
      [3135.96, 0.11, 0.105],
      [4703.94, 0.052, 0.068],
      [6271.92, 0.022, 0.042]
    ] as const).forEach(([frequency, volume, duration]) => {
      const bell = context.createOscillator();
      const gain = context.createGain();
      bell.type = "sine";
      bell.frequency.setValueAtTime(frequency, lockAt);
      gain.gain.setValueAtTime(0.0001, lockAt);
      gain.gain.exponentialRampToValueAtTime(volume, lockAt + 0.0015);
      gain.gain.exponentialRampToValueAtTime(0.0001, lockAt + duration);
      bell.connect(gain).connect(master);
      bell.start(lockAt);
      bell.stop(lockAt + duration + 0.008);
    });

    const sampleCount = Math.floor(context.sampleRate * 0.014);
    const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) samples[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / sampleCount, 6);
    const transient = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    transient.buffer = buffer;
    filter.type = "highpass";
    filter.frequency.value = 4200;
    gain.gain.setValueAtTime(0.075, lockAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, lockAt + 0.014);
    transient.connect(filter).connect(gain).connect(master);
    transient.start(lockAt);
  }

  function moveTo(index: number, navigate: boolean) {
    const step = shortestStep(currentIndex.current, index);
    if (step === 0) return;
    currentIndex.current = index;
    setRotation((value) => value - step * 90);
    setTurning(false);
    window.requestAnimationFrame(() => setTurning(true));
    window.setTimeout(() => setTurning(false), 520);
    if (navigate) {
      playTurn(step);
      onSelect(DOORS[index].key);
    }
  }

  useEffect(() => {
    const next = DOORS.findIndex((door) => door.key === activeKey);
    if (next >= 0) moveTo(next, false);
    // activeKey is the only external synchronization signal; moveTo remains event-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  useEffect(() => () => stopAllSound(), []);

  return (
    <div className="four-door-zone">
      <button
        type="button"
        className="four-door-sound"
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6.8 8.5H3v7h3.8L11 19Z" /><path d="M4 4 20 20" /></svg>
        )}
      </button>
      <div className={`four-door-art ${turning ? "is-turning" : ""}`}>
        <img className="four-door-window" src="/uploads/feature/four-door/window.png" alt="霍尔的移动城堡窗户" />
        <div className="four-door-wheel" style={{ transform: `rotate(${rotation}deg)` }} role="group" aria-label="四色门工作区入口">
          <img src="/uploads/feature/four-door/dial.png" alt="" />
          {DOORS.map((door, index) => <button key={door.key} type="button" className={`four-door-sector ${door.color}`} aria-label={`${door.label}入口`} onClick={() => moveTo(index, true)} />)}
        </div>
        <img className="four-door-pointer four-door-pointer-arch" src="/uploads/feature/four-door/pointer.png" alt="" />
        <img className="four-door-pointer four-door-pointer-tip" src="/uploads/feature/four-door/pointer.png" alt="固定指针" />
        <button type="button" className="four-door-advance" aria-label="旋转至下一个工作区" title="旋转至下一个工作区" onClick={() => moveTo((currentIndex.current + 1) % DOORS.length, true)} />
        <img className="four-door-hand" src="/uploads/feature/four-door/cursor-hand.png" alt="" aria-hidden="true" />
      </div>
    </div>
  );
}
