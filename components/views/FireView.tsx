"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FALLBACK_RATES, type StockRecord, type Quote } from "@/lib/types";
import { usdCap } from "@/lib/currency";
import CurrencyFlag from "@/components/CurrencyFlag";
import { CURRENCIES, type CurrencyCode, useDisplayCurrency } from "@/lib/currencyPrefs";
import FireReefCurrent from "@/components/FireReefCurrent";
import { fmtMoneyAdaptive } from "@/lib/format";

const CURRENCY_OPTIONS: { value: CurrencyCode; label: string; code: CurrencyCode; market: string; flag: string }[] = CURRENCIES.map((c) => ({
  value: c.code,
  label: c.label,
  code: c.code,
  market: c.market,
  flag: c.flag
}));
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", HKD: "HK$", CNY: "¥", JPY: "¥", KRW: "₩", SGD: "S$" };

type FireViewProps = {
  records: StockRecord[];
  quotes: Record<string, Quote>;
  livePrice: (r: StockRecord) => number;
};

function fmtPct2(n: number, digits = 1) {
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function round2(n: number) {
  return Number(n.toFixed(2));
}

/** 旧版把主货币目标换成 USD 保存，汇率变化后换回会产生小幅漂移；迁移时恢复明显的整万目标。 */
function normalizeLegacyFireTarget(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const roundedWan = Math.round(value / 10_000) * 10_000;
  return Math.abs(value - roundedWan) <= Math.max(10, value * 0.0005) ? roundedWan : Math.round(value);
}

function lsGet(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function lsSet(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* 忽略 */ }
}

// 生成波浪液面路径：宽于绘图区（x1-x0 为周期 T 的整数倍），平移一个周期即可无缝循环（液体涌动）。
function wavePath(waterY: number, opts?: { amp?: number; phase?: number; x0?: number; x1?: number }) {
  const amp = opts?.amp ?? 6;
  const T = 48;
  const half = T / 2;
  const x0 = opts?.x0 ?? -144;
  const x1 = opts?.x1 ?? 336;
  let d = `M ${x0} ${waterY}`;
  let up = ((opts?.phase ?? 0) % T) < half;
  for (let x = x0; x < x1; x += half) {
    const cy = up ? waterY - amp : waterY + amp;
    d += ` q ${half / 2} ${cy - waterY} ${half} 0`;
    up = !up;
  }
  d += ` L ${x1} 240 L ${x0} 240 Z`;
  return d;
}

function FishPair() {
  return (
    <>
      <span className="fire-family-father">
        <span className="fire-jump-fish fire-jump-fish-father">
          <i className="fire-fish-tail" />
          <i className="fire-fish-body" />
        </span>
        <span className="fire-fish-breath"><i /><i /><i /></span>
      </span>
      <span className="fire-family-child">
        <span className="fire-jump-fish fire-jump-fish-child">
          <i className="fire-fish-tail" />
          <i className="fire-fish-body" />
        </span>
        <span className="fire-fish-breath"><i /><i /><i /></span>
      </span>
    </>
  );
}

function ClownfishFamily() {
  return (
    <div className="fire-fish-family-stage" aria-hidden="true">
      <span className="fire-jelly-friend"><i /><i /><i /><i /></span>
      <span className="fire-crab-friend"><i className="fire-crab-eye" /><i className="fire-crab-eye" /><i className="fire-crab-claw" /><i className="fire-crab-claw" /></span>
      <FishPair />
      <span className="fire-family-home">
        <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
      </span>
      <span className="fire-family-home fire-family-turn-home">
        <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
      </span>
    </div>
  );
}

function GlassFishRefraction() {
  return (
    <div className="fire-glass-fish-lens" aria-hidden="true">
      <div className="fire-fish-family-stage fire-fish-glass-stage"><FishPair /></div>
    </div>
  );
}

function OceanAmbient() {
  return (
    <div className="fire-ocean-ambient" aria-hidden="true">
      <FireReefCurrent />
      <div className="fire-ocean-surface" />
      <div className="fire-ocean-rays" />
      <div className="fire-ocean-particles">
        {Array.from({ length: 14 }, (_, index) => <i key={index} />)}
      </div>
      <div className="fire-anemone fire-anemone-left">
        {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
      </div>
      <div className="fire-anemone fire-anemone-right">
        {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
      </div>
      <div className="fire-reef-vignette" />
    </div>
  );
}

const fireCss = `
@keyframes fireWaveX { from { transform: translateX(0); } to { transform: translateX(-48px); } }
@keyframes fireBobY { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.4px); } }
@keyframes fireBreathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.014); } }
@keyframes fireBarWave { from { transform: translateX(0); } to { transform: translateX(-12px); } }
@keyframes fireBarWaveBack { from { transform: translateX(0); } to { transform: translateX(-12px); } }
@keyframes fireBarBreathe { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1px); } }
.fire-wave { animation: fireWaveX 6s linear infinite; }
.fire-wave-back { animation: fireWaveX 9s linear infinite; }
.fire-liquid { animation: fireBobY 5s ease-in-out infinite; }
.fire-bubble { animation: fireBreathe 6.5s ease-in-out infinite; transform-origin: center; }
.fire-bar-wave { animation: fireBarWave 5s linear infinite; }
.fire-bar-wave-back { animation: fireBarWaveBack 7s linear infinite; }
.fire-bar-breathe { animation: fireBarBreathe 4s ease-in-out infinite; }
.fire-page { font-family: "SF Pro Display", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
.fire-page * { font-family: inherit; font-variant-numeric: tabular-nums; }
.fire-bubble { cursor: pointer; }
.fire-bubble:hover .fire-wave { animation-duration: 1.5s; }
.fire-bubble:hover .fire-wave-back { animation-duration: 2.3s; }
.fire-bubble:hover .fire-liquid { animation-duration: 1.7s; }
.fire-bubble:hover { animation-duration: 3s; }
.fire-progress { cursor: pointer; }
.fire-progress:hover .fire-bar-wave { animation-duration: 1.5s; }
.fire-progress:hover .fire-bar-wave-back { animation-duration: 2.2s; }
.fire-progress:hover .fire-bar-breathe { animation-duration: 1.6s; }
@keyframes fireSaveShimmer { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
@keyframes fireSaveGlow { 0%,100% { box-shadow: 0 2px 10px rgba(43,124,255,.35); } 50% { box-shadow: 0 5px 18px rgba(43,124,255,.6); } }
.fire-save-btn {
  background-image: linear-gradient(90deg, #1be0e8, #3f8bff, #2f7cff, #1be0e8);
  background-size: 300% 100%;
  animation: fireSaveShimmer 5s ease-in-out infinite, fireSaveGlow 3s ease-in-out infinite;
}
@keyframes fireCancelBreath {
  0%, 100% { box-shadow: 0 2px 6px rgba(0,0,0,.10); }
  50% { box-shadow: 0 6px 18px rgba(0,0,0,.18); }
}
.fire-cancel-btn {
  animation: fireCancelBreath 2.8s ease-in-out infinite;
  transition: transform .12s ease, background-color .2s ease, border-color .2s ease, color .2s ease, box-shadow .2s ease;
}
.fire-cancel-btn:active { transform: scale(.94); }
.fire-currency-switch { transition: transform .42s cubic-bezier(.22,1,.36,1), box-shadow .42s ease, border-color .3s ease, background-color .3s ease; }
.fire-currency-switch > img,.fire-currency-switch > span { transition: transform .55s cubic-bezier(.22,1,.36,1), filter .4s ease; }
.fire-currency-switch:hover { transform: translateY(-1px) scale(1.045); border-color: rgba(49,190,202,.52); box-shadow: 0 6px 15px rgba(11,180,180,.14); }
.fire-currency-switch:hover > img,.fire-currency-switch:hover > span { transform: rotate(7deg) scale(1.06); filter: saturate(1.12) brightness(1.04); }
.fire-currency-switch:active { transform: translateY(0) scale(.96); transition-duration: .12s; }
@keyframes fireSwitchWave { from { transform: translateX(-.7px) translateY(.3px); } to { transform: translateX(.7px) translateY(-.3px); } }
.fire-scene-switch { transition: transform .42s cubic-bezier(.22,1,.36,1), box-shadow .42s ease, border-color .3s ease, background-color .3s ease; }
.fire-scene-switch:hover { transform: translateY(-1px) scale(1.045); border-color: rgba(49,190,202,.72); box-shadow: 0 5px 16px rgba(11,180,180,.24); }
.fire-scene-switch:hover svg { animation: fireSwitchWave .8s ease-in-out infinite alternate; }
.fire-scene-switch:active { transform: translateY(0) scale(.94); transition-duration: .12s; }
.fire-edit-button { transition: transform .42s cubic-bezier(.22,1,.36,1), box-shadow .42s ease, border-color .3s ease, background-color .3s ease, letter-spacing .35s ease; }
.fire-edit-button:hover { transform: translateY(-1px) scale(1.025); border-color: rgba(107,114,128,.68); box-shadow: 0 6px 16px rgba(10,14,25,.11); letter-spacing: .02em; }
.dark .fire-edit-button:hover { border-color: rgba(255,255,255,.28); box-shadow: 0 6px 18px rgba(0,0,0,.22); }
.fire-edit-button:active { transform: translateY(0) scale(.96); transition-duration: .12s; }
@keyframes fireRaySway { 0%, 100% { transform: translateX(-1.5px); opacity: .5; } 50% { transform: translateX(1.5px); opacity: .85; } }
@keyframes fireCausticDrift { 0%, 100% { transform: translateX(-3px); opacity: .35; } 50% { transform: translateX(3px); opacity: .7; } }
.fire-rays { animation: fireRaySway 7s ease-in-out infinite; }
.fire-caustics { animation: fireCausticDrift 4.6s ease-in-out infinite; }
@keyframes fireCausticDriftB { 0%, 100% { transform: translateX(-4px); opacity: .4; } 50% { transform: translateX(4px); opacity: .85; } }
.fire-caustics-b { animation: fireCausticDriftB 3.4s ease-in-out infinite; }
@keyframes fireRipple { 0%, 100% { opacity: .45; } 50% { opacity: .85; } }
.fire-ripples { animation: fireRipple 3.2s ease-in-out infinite; }
@keyframes fireBubbleRise { 0% { transform: translateY(0); opacity: 0; } 15% { opacity: .85; } 100% { transform: translateY(-34px); opacity: 0; } }
.fire-bubbles circle { animation: fireBubbleRise 5s linear infinite; }
.fire-bubbles circle:nth-child(2) { animation-delay: -1.2s; }
.fire-bubbles circle:nth-child(3) { animation-delay: -2.4s; }
.fire-bubbles circle:nth-child(4) { animation-delay: -3.6s; }
@keyframes fireFatherJourney {
  0%,5% { opacity:1; transform:translate3d(-240px,245px,0) rotate(-10deg) scale(.72); }
  8% { opacity:1; transform:translate3d(-83px,211px,0) rotate(-8deg) scale(.76); }
  10% { opacity:1; transform:translate3d(-104px,227px,0) rotate(-11deg) scale(.73); }
  13% { opacity:1; transform:translate3d(-63px,198px,0) rotate(-7deg) scale(.8); }
  17% { opacity:1; transform:translate3d(18px,153px,0) rotate(-11deg) scale(.91); }
  28% { opacity:1; transform:translate3d(210px,67px,0) rotate(-5deg) scale(1); }
  39% { opacity:1; transform:translate3d(430px,39px,0) rotate(5deg) scale(1.02); }
  47% { opacity:1; transform:translate3d(650px,102px,0) rotate(13deg) rotateY(0deg) scale(.96); }
  49% { opacity:.38; transform:translate3d(698px,142px,0) rotate(24deg) rotateY(0deg) scale(.88); }
  50%,54% { opacity:0; transform:translate3d(710px,184px,0) rotate(32deg) rotateY(0deg) scale(.82); }
  55% { opacity:.28; transform:translate3d(682px,176px,0) rotate(14deg) rotateY(180deg) scale(.86); }
  57% { opacity:1; transform:translate3d(640px,143px,0) rotate(8deg) rotateY(180deg) scale(.94); }
  63% { opacity:1; transform:translate3d(490px,82px,0) rotate(3deg) rotateY(180deg) scale(1); }
  73% { opacity:1; transform:translate3d(300px,112px,0) rotate(-7deg) rotateY(180deg) scale(.98); }
  83% { opacity:1; transform:translate3d(105px,181px,0) rotate(-13deg) rotateY(180deg) scale(.88); }
  90% { opacity:1; transform:translate3d(-52px,232px,0) rotate(-17deg) rotateY(180deg) scale(.75); }
  96%,100% { opacity:1; transform:translate3d(-240px,270px,0) rotate(-20deg) rotateY(180deg) scale(.66); }
}
@keyframes fireChildJourney {
  0%,10% { opacity:1; transform:translate3d(-220px,258px,0) rotate(-12deg) scale(.64); }
  13% { opacity:1; transform:translate3d(-123px,228px,0) rotate(-10deg) scale(.68); }
  15% { opacity:1; transform:translate3d(-142px,243px,0) rotate(-12deg) scale(.65); }
  18% { opacity:1; transform:translate3d(-103px,216px,0) rotate(-9deg) scale(.72); }
  21% { opacity:1; transform:translate3d(-28px,178px,0) rotate(-13deg) scale(.82); }
  32% { opacity:1; transform:translate3d(160px,92px,0) rotate(-6deg) scale(.9); }
  39% { opacity:1; transform:translate3d(298px,49px,0) rotate(-9deg) scale(.92); }
  43% { opacity:1; transform:translate3d(355px,8px,0) rotate(-18deg) scale(.94); }
  47% { opacity:1; transform:translate3d(445px,69px,0) rotate(18deg) scale(.9); }
  52% { opacity:1; transform:translate3d(590px,128px,0) rotate(3deg) rotateY(0deg) scale(.88); }
  54% { opacity:.35; transform:translate3d(630px,158px,0) rotate(25deg) rotateY(0deg) scale(.78); }
  55%,59% { opacity:0; transform:translate3d(650px,196px,0) rotate(32deg) rotateY(0deg) scale(.72); }
  60% { opacity:.3; transform:translate3d(610px,185px,0) rotate(14deg) rotateY(180deg) scale(.76); }
  62% { opacity:1; transform:translate3d(570px,155px,0) rotate(7deg) rotateY(180deg) scale(.87); }
  65% { opacity:1; transform:translate3d(455px,108px,0) rotate(2deg) rotateY(180deg) scale(.9); }
  71% { opacity:1; transform:translate3d(355px,158px,0) rotate(13deg) rotateY(180deg) scale(.9); }
  76% { opacity:1; transform:translate3d(280px,112px,0) rotate(-14deg) rotateY(180deg) scale(.91); }
  85% { opacity:1; transform:translate3d(82px,195px,0) rotate(-12deg) rotateY(180deg) scale(.8); }
  92% { opacity:1; transform:translate3d(-76px,242px,0) rotate(-18deg) rotateY(180deg) scale(.68); }
  97%,100% { opacity:1; transform:translate3d(-220px,279px,0) rotate(-21deg) rotateY(180deg) scale(.6); }
}
.fire-bubble-scene { min-height: 340px; isolation: isolate; overflow: hidden; border: 0; border-radius: 28px; background: transparent; }
.fire-ocean-ambient { position: absolute; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
@keyframes fireReefDrift { 0%,100% { transform: scale(1.065) translate3d(-.6%,0,0); } 50% { transform: scale(1.095) translate3d(.6%,-1.2%,0); } }
.fire-reef-depth { position: absolute; inset: -5%; background-image: url('/images/fire/coral-reef-transparent.png'); background-size: cover; background-position: center 55%; filter: saturate(.88) brightness(.9); opacity: .92; -webkit-mask-image: radial-gradient(ellipse 73% 91% at 50% 52%,#000 0 66%,rgba(0,0,0,.86) 78%,transparent 100%); mask-image: radial-gradient(ellipse 73% 91% at 50% 52%,#000 0 66%,rgba(0,0,0,.86) 78%,transparent 100%); animation: fireReefDrift 22s ease-in-out infinite; }
.dark .fire-reef-depth { opacity: .84; filter: saturate(.92) brightness(.76); }
.fire-reef-current { position: absolute; inset: -5%; width: 110%; height: 110%; opacity: 0; pointer-events: none; transition: opacity .8s ease; }
.fire-reef-current.is-ready { opacity: .92; }
.dark .fire-reef-current.is-ready { opacity: .98; filter:saturate(1.12) brightness(1.08); }
@keyframes fireSurfaceRefraction { 0% { transform:translate3d(-3%,0,0) scaleX(1.04); opacity:.48; } 50% { transform:translate3d(2%,-2px,0) scaleX(.98); opacity:.76; } 100% { transform:translate3d(4%,1px,0) scaleX(1.05); opacity:.5; } }
.fire-ocean-surface { position:absolute; z-index:1; left:-8%; right:-8%; top:-12px; height:42%; pointer-events:none; opacity:.58; mix-blend-mode:screen; background:radial-gradient(ellipse 13% 5% at 12% 8%,rgba(218,255,255,.74),transparent 72%),radial-gradient(ellipse 18% 6% at 36% 5%,rgba(183,250,255,.57),transparent 74%),radial-gradient(ellipse 15% 5% at 62% 9%,rgba(212,255,255,.65),transparent 72%),radial-gradient(ellipse 19% 6% at 87% 4%,rgba(172,243,255,.55),transparent 75%),linear-gradient(180deg,rgba(133,237,249,.18),transparent 72%); filter:blur(3px); -webkit-mask-image:linear-gradient(180deg,#000 0,rgba(0,0,0,.68) 34%,transparent 100%); mask-image:linear-gradient(180deg,#000 0,rgba(0,0,0,.68) 34%,transparent 100%); animation:fireSurfaceRefraction 8s ease-in-out infinite alternate; }
@keyframes fireOceanRays { from { transform: translate3d(-9%,0,0) skewX(-8deg); opacity: .16; } to { transform: translate3d(10%,0,0) skewX(7deg); opacity: .31; } }
.fire-ocean-rays { position: absolute; inset: -35% -15% 0; background: repeating-linear-gradient(104deg,transparent 0 13%,rgba(86,222,237,.11) 16%,transparent 21% 34%); filter: blur(12px); mix-blend-mode: screen; animation: fireOceanRays 12s ease-in-out infinite alternate; }
.fire-reef-vignette { position: absolute; inset: 0; background: radial-gradient(circle at 50% 44%,rgba(54,201,217,.035),transparent 66%); }
.dark .fire-reef-vignette { background: radial-gradient(circle at 50% 44%,transparent 0 25%,rgba(4,10,22,.05) 51%,transparent 86%); }
@keyframes fireOceanParticle { 0% { transform: translate3d(0,24px,0) scale(.7); opacity: 0; } 18% { opacity: .42; } 100% { transform: translate3d(18px,-245px,0) scale(1.12); opacity: 0; } }
.fire-ocean-particles { position: absolute; inset: 0; }
.fire-ocean-particles i { position: absolute; bottom: -12px; width: 3px; height: 3px; border-radius: 50%; background: rgba(150,238,244,.76); box-shadow: 0 0 7px rgba(66,207,224,.5); animation: fireOceanParticle 8s linear infinite; }
.fire-ocean-particles i:nth-child(1) { left: 5%; animation-delay: -1s; }.fire-ocean-particles i:nth-child(2) { left: 12%; animation-delay: -6s; width: 2px; height: 2px; }.fire-ocean-particles i:nth-child(3) { left: 20%; animation-delay: -3.5s; }.fire-ocean-particles i:nth-child(4) { left: 29%; animation-delay: -7s; width: 4px; height: 4px; }.fire-ocean-particles i:nth-child(5) { left: 37%; animation-delay: -2s; }.fire-ocean-particles i:nth-child(6) { left: 45%; animation-delay: -5s; width: 2px; height: 2px; }.fire-ocean-particles i:nth-child(7) { left: 53%; animation-delay: -8s; }.fire-ocean-particles i:nth-child(8) { left: 61%; animation-delay: -4s; width: 4px; height: 4px; }.fire-ocean-particles i:nth-child(9) { left: 68%; animation-delay: -6.8s; }.fire-ocean-particles i:nth-child(10) { left: 75%; animation-delay: -1.8s; width: 2px; height: 2px; }.fire-ocean-particles i:nth-child(11) { left: 82%; animation-delay: -5.7s; }.fire-ocean-particles i:nth-child(12) { left: 90%; animation-delay: -3s; width: 4px; height: 4px; }.fire-ocean-particles i:nth-child(13) { left: 95%; animation-delay: -7.6s; }.fire-ocean-particles i:nth-child(14) { left: 57%; animation-delay: -.5s; width: 2px; height: 2px; }
@keyframes fireCurrentSway { 0%,100% { transform: rotate(-8deg) scaleY(.98); } 50% { transform: rotate(11deg) scaleY(1.035); } }
.fire-anemone { position: absolute; bottom: -4px; z-index: 3; display: flex; align-items: flex-end; gap: 3px; height: 92px; filter: drop-shadow(0 4px 7px rgba(0,0,0,.28)); }
.fire-anemone-left { left: 4%; }.fire-anemone-right { right: 4%; transform: scaleX(-1); }
.fire-anemone i { width: 8px; height: 66px; border-radius: 90% 90% 45% 45%; transform-origin: 50% 100%; background: linear-gradient(90deg,#5f274f,#bd624c 55%,#f2a477); box-shadow: inset 1px 0 rgba(255,255,255,.16); animation: fireCurrentSway 4.4s ease-in-out infinite; }
.fire-anemone i:nth-child(2n) { height: 82px; animation-duration: 5.1s; animation-delay: -1.8s; }.fire-anemone i:nth-child(3n) { height: 54px; width: 7px; animation-duration: 3.7s; animation-delay: -2.5s; }.fire-anemone i:nth-child(4n) { height: 73px; animation-delay: -3.3s; }.fire-anemone i:nth-child(5n) { height: 46px; animation-duration: 4.8s; animation-delay: -.8s; }
@keyframes fireFishSwimBody { 0%,100% { transform: rotate(-1.8deg) scaleX(.975) scaleY(1.015); } 50% { transform: rotate(1.8deg) scaleX(1.018) scaleY(.985); } }
@keyframes fireTailBeat { 0%,100% { transform:rotate(-8deg) scaleY(.92); } 50% { transform:rotate(10deg) scaleY(1.08); } }
@keyframes fireBreathBubble { 0% { opacity:0; transform:translate3d(0,5px,0) scale(.55); } 18% { opacity:.68; } 100% { opacity:0; transform:translate3d(18px,-28px,0) scale(1.15); } }
@keyframes fireJellyMeet { 0%,42%,72%,100% { opacity:0; transform:translate3d(0,18px,0) scale(.75); } 48% { opacity:.68; transform:translate3d(-3px,0,0) scale(.95); } 57% { opacity:.92; transform:translate3d(5px,-11px,0) scale(1.04); } 66% { opacity:.48; transform:translate3d(-2px,-20px,0) scale(.9); } }
@keyframes fireJellyPulse { 0%,100% { transform:scaleX(1) scaleY(.88); } 50% { transform:scaleX(.88) scaleY(1.08); } }
@keyframes fireCrabHello { 0%,61%,88%,100% { opacity:0; transform:translateY(18px) rotate(-5deg); } 67%,82% { opacity:.9; transform:translateY(0) rotate(3deg); } }
@keyframes fireCrabWave { 0%,100% { transform:rotate(-13deg); } 50% { transform:rotate(25deg); } }
@keyframes fireHomeCurrent { 0%,100% { transform:rotate(var(--home-rest,-7deg)) scaleY(.97); } 50% { transform:rotate(var(--home-sway,9deg)) scaleY(1.035); } }
.fire-fish-family-stage { position:absolute; inset:0; z-index:2; pointer-events:none; overflow:hidden; perspective:900px; perspective-origin:72% 48%; }
.fire-glass-fish-lens { position:absolute; inset:0; z-index:9; overflow:hidden; pointer-events:none; background:rgba(70,162,183,.055); -webkit-mask-image:radial-gradient(circle 124px at 50% 50%,#000 0 91%,rgba(0,0,0,.92) 94%,rgba(0,0,0,.36) 98%,transparent 100%); mask-image:radial-gradient(circle 124px at 50% 50%,#000 0 91%,rgba(0,0,0,.92) 94%,rgba(0,0,0,.36) 98%,transparent 100%); backdrop-filter:blur(.35px) saturate(1.08); }
.fire-fish-glass-stage { z-index:1; transform:scale(1.1); transform-origin:50% 50%; filter:saturate(1.06) contrast(1.02); }
.fire-family-father,.fire-family-child { position:absolute; left:4%; top:4px; opacity:0; transform-style:preserve-3d; will-change:transform,opacity; }
.fire-family-father { animation:fireFatherJourney 20s cubic-bezier(.36,.03,.28,1) infinite; }
.fire-family-child { animation:fireChildJourney 20s cubic-bezier(.36,.03,.28,1) infinite; }
.fire-jump-fish { position:relative; display:block; filter:drop-shadow(0 9px 12px rgba(8,72,117,.3)); transform-origin:64% 52%; animation:fireFishSwimBody .72s ease-in-out infinite; will-change:transform; }
.fire-jump-fish-father { width:118px; height:86px; --fish-bg-size:194px 109px; --fish-bg-position:-3px -11px; }
.fire-jump-fish-child { width:82px; height:60px; --fish-bg-size:208px 117px; --fish-bg-position:-128px -48px; animation-duration:.58s; }
.fire-fish-body,.fire-fish-tail { position:absolute; inset:0; display:block; background-image:url('/images/fire/clownfish-family.png'); background-repeat:no-repeat; background-size:var(--fish-bg-size); background-position:var(--fish-bg-position); }
.fire-fish-body { clip-path:polygon(25% 0,100% 0,100% 100%,25% 100%); }
.fire-fish-tail { clip-path:polygon(0 4%,42% 5%,45% 96%,0 96%); transform-origin:36% 52%; animation:fireTailBeat .36s ease-in-out infinite; }
.fire-family-child .fire-fish-tail { animation-duration:.28s; }
.fire-fish-breath { position:absolute; left:88%; top:31%; width:34px; height:36px; }
.fire-fish-breath i { position:absolute; left:0; bottom:0; width:5px; height:5px; border:1px solid rgba(159,240,247,.72); border-radius:50%; box-shadow:0 0 5px rgba(76,213,226,.38); animation:fireBreathBubble 1.9s ease-out infinite; }
.fire-fish-breath i:nth-child(2) { left:6px; width:3px; height:3px; animation-delay:-.62s; }
.fire-fish-breath i:nth-child(3) { left:2px; width:4px; height:4px; animation-delay:-1.24s; }
.fire-jelly-friend { position:absolute; z-index:1; left:47%; top:58px; width:38px; height:31px; border-radius:54% 54% 42% 42%; opacity:0; background:radial-gradient(circle at 38% 30%,rgba(255,255,255,.72) 0 7%,transparent 9%),linear-gradient(145deg,rgba(151,239,244,.72),rgba(113,117,232,.5)); box-shadow:inset 0 0 12px rgba(255,255,255,.32),0 0 16px rgba(92,220,234,.22); animation:fireJellyMeet 20s ease-in-out infinite,fireJellyPulse 1.6s ease-in-out infinite; }
.fire-jelly-friend i { position:absolute; top:25px; width:2px; height:23px; border-radius:50%; background:linear-gradient(rgba(154,226,242,.72),transparent); transform-origin:top; animation:fireCurrentSway 2.1s ease-in-out infinite; }.fire-jelly-friend i:nth-child(1){left:7px}.fire-jelly-friend i:nth-child(2){left:15px;height:29px;animation-delay:-.6s}.fire-jelly-friend i:nth-child(3){left:23px;height:25px;animation-delay:-1.1s}.fire-jelly-friend i:nth-child(4){left:31px;height:20px;animation-delay:-1.5s}
.fire-crab-friend { position:absolute; z-index:3; right:12%; bottom:24px; width:46px; height:25px; border-radius:48% 48% 40% 40%; opacity:0; background:linear-gradient(155deg,#f58b67,#c94f55); box-shadow:inset 0 2px rgba(255,255,255,.22),0 5px 8px rgba(22,47,70,.2); animation:fireCrabHello 20s ease-in-out infinite; }
.fire-crab-eye { position:absolute; top:-5px; width:7px; height:8px; border-radius:50%; background:#f6b59c; border-top:3px solid #263342; }.fire-crab-eye:nth-child(1){left:11px}.fire-crab-eye:nth-child(2){right:11px}
.fire-crab-claw { position:absolute; top:3px; width:15px; height:13px; border-radius:60% 40% 55% 45%; background:#e66b5b; transform-origin:bottom center; animation:fireCrabWave .72s ease-in-out infinite; }.fire-crab-claw:nth-child(3){left:-11px}.fire-crab-claw:nth-child(4){right:-11px;animation-delay:-.36s}
.fire-family-home { position:absolute; left:0; bottom:-8px; z-index:4; display:flex; width:178px; height:126px; align-items:flex-end; justify-content:center; gap:2px; pointer-events:none; filter:drop-shadow(0 8px 12px rgba(10,35,47,.28)); }
.fire-family-home::after { content:""; position:absolute; bottom:-12px; left:3px; right:3px; height:42px; border-radius:50% 50% 24% 24%; background:radial-gradient(ellipse at 50% 0,rgba(235,150,103,.72),rgba(111,45,76,.92) 64%,rgba(45,26,59,.92)); }
.fire-family-turn-home { left:620px; bottom:2px; transform:scaleX(-1) scale(.92); transform-origin:bottom center; opacity:.88; }
.fire-family-home i { position:relative; z-index:1; width:12px; height:var(--home-h,82px); flex:none; border-radius:80% 80% 42% 42%; transform-origin:50% 100%; background:linear-gradient(90deg,#633455 0%,#c46e62 52%,#f0ae84 78%,#945065 100%); box-shadow:inset 2px 0 2px rgba(255,255,255,.15),inset -2px 0 3px rgba(40,15,45,.2); animation:fireHomeCurrent var(--home-speed,4.1s) ease-in-out infinite; }
.fire-family-home i:nth-child(1){--home-h:66px;--home-rest:-13deg;--home-sway:4deg;--home-speed:4.8s}.fire-family-home i:nth-child(2){--home-h:92px;--home-rest:-12deg;--home-sway:8deg;--home-speed:5.4s;animation-delay:-1.3s}.fire-family-home i:nth-child(3){--home-h:76px;--home-rest:-8deg;--home-sway:13deg;--home-speed:4.3s;animation-delay:-2.1s}.fire-family-home i:nth-child(4){--home-h:108px;--home-rest:-7deg;--home-sway:7deg;--home-speed:5.7s;animation-delay:-3.4s}.fire-family-home i:nth-child(5){--home-h:88px;--home-rest:-4deg;--home-sway:12deg;--home-speed:4.7s;animation-delay:-.7s}.fire-family-home i:nth-child(6){--home-h:118px;--home-rest:-5deg;--home-sway:8deg;--home-speed:6.1s;animation-delay:-2.8s}.fire-family-home i:nth-child(7){--home-h:101px;--home-rest:-9deg;--home-sway:5deg;--home-speed:5.2s;animation-delay:-1.8s}.fire-family-home i:nth-child(8){--home-h:82px;--home-rest:-12deg;--home-sway:9deg;--home-speed:4.5s;animation-delay:-3.1s}.fire-family-home i:nth-child(9){--home-h:105px;--home-rest:-8deg;--home-sway:6deg;--home-speed:5.8s;animation-delay:-.9s}.fire-family-home i:nth-child(10){--home-h:74px;--home-rest:-13deg;--home-sway:4deg;--home-speed:4.2s;animation-delay:-2.4s}.fire-family-home i:nth-child(11){--home-h:61px;--home-rest:-10deg;--home-sway:8deg;--home-speed:5s;animation-delay:-1.1s}
@media (max-width: 720px) {
  .fire-bubble-scene { min-height: 260px; border-radius: 20px; }
  .fire-reef-depth { background-position: center; filter: saturate(.8) brightness(.68); }
  .fire-anemone { height: 60px; transform: scale(.72); transform-origin: bottom left; }
  .fire-anemone-right { transform: scaleX(-1) scale(.72); transform-origin: bottom right; }
  .fire-fish-family-stage { width:154%; height:154%; transform:scale(.65); transform-origin:left top; }
  .fire-fish-glass-stage { transform:scale(.715); }
  .fire-family-home { left:-8px; }
}
@media (max-width: 420px) {
  .fire-fish-family-stage { width:172%; height:172%; transform:scale(.58); opacity:.88; }
}
@media (prefers-reduced-motion: reduce) {
  .fire-family-father, .fire-family-child, .fire-jump-fish, .fire-fish-tail, .fire-fish-breath i, .fire-jelly-friend, .fire-crab-friend { animation:none; opacity:0; }
  .fire-family-home i { animation:none; }
  .fire-reef-depth, .fire-ocean-surface, .fire-ocean-rays, .fire-ocean-particles i, .fire-anemone i { animation: none; }
}
`;

export default function FireView({ records, quotes, livePrice }: FireViewProps) {
  // FIRE 页面有用户本地化配置（币种、计划值等），服务端无法读取 localStorage。
  // 首帧保持稳定占位，挂载后再显示真实配置，避免水合报错与 USD → 本地币种闪回。
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [annualExpense, setAnnualExpense] = useState(() => Number(lsGet("fire:p-expense", "60000")) || 60000);
  const [withdrawalRate, setWithdrawalRate] = useState(() => Number(lsGet("fire:p-withdrawal", "4")) || 4); // %
  const [annualReturn, setAnnualReturn] = useState(() => Number(lsGet("fire:p-return", "7")) || 7); // %
  const [inflation, setInflation] = useState(() => Number(lsGet("fire:p-inflation", "3")) || 3); // %
  const [savingsRate, setSavingsRate] = useState(() => Number(lsGet("fire:p-savings", "50")) || 50); // %
  useEffect(() => {
    lsSet("fire:p-expense", String(annualExpense));
    lsSet("fire:p-withdrawal", String(withdrawalRate));
    lsSet("fire:p-return", String(annualReturn));
    lsSet("fire:p-inflation", String(inflation));
    lsSet("fire:p-savings", String(savingsRate));
  }, [annualExpense, withdrawalRate, annualReturn, inflation, savingsRate]);

  const [rates, setRates] = useState<Record<string, number>>({ ...FALLBACK_RATES });
  const [ratesAt, setRatesAt] = useState<number>(Date.now());
  useEffect(() => {
    let alive = true;
    fetch("/api/rates")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data?.rates) { setRates({ ...FALLBACK_RATES, ...data.rates, USD: data.rates.USD ?? 1 }); setRatesAt(Date.now()); }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // 各币种持仓统一换算成 USD（避免 USD/HKD/CNY 直接相加的错误）
  const { currentAssets, costAssets } = useMemo(() => {
    let market = 0;
    let cost = 0;
    for (const r of records) {
      const qty = Number(r.qty) || 0;
      const localValue = qty * (livePrice(r) || 0);
      const localCost = qty * (Number(r.cost) || 0);
      market += usdCap(r.market, localValue, rates);
      cost += usdCap(r.market, localCost, rates);
    }
    return { currentAssets: market, costAssets: cost };
  }, [records, livePrice, rates]);

  // —— 货币：真实净资产 & FIRE 计划值统一到「显示币种」，进度比率保持稳定 ——
  const { currency: displayCurrency, setCurrency: setDisplayCurrency } = useDisplayCurrency();
  // 默认/主货币：FIRE 计划数值以它录入，显示时再从它换算到「显示币种」
  const [baseCurrency, setBaseCurrency] = useState<CurrencyCode>(() => {
    if (typeof window === "undefined") return "CNY";
    const saved = localStorage.getItem("fire:base-currency");
    return CURRENCIES.some((c) => c.code === saved) ? (saved as CurrencyCode) : "CNY";
  });
  const [currencyMenuOpen, setCurrencyMenuOpen] = useState(false);
  const [oceanSceneEnabled, setOceanSceneEnabled] = useState(() => lsGet("fire:fire-ocean-scene", "1") !== "0");
  const [bubbleHover, setBubbleHover] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { lsSet("fire:fire-ocean-scene", oceanSceneEnabled ? "1" : "0"); }, [oceanSceneEnabled]);
  const curRate = rates[displayCurrency] || 1;
  const baseRate = rates[baseCurrency] || 1;
  const k = curRate / baseRate; // 主货币 → 显示币种的换算系数
  const curSymbol = CURRENCY_SYMBOLS[displayCurrency] || "$";
  const curOption = CURRENCY_OPTIONS.find((c) => c.value === displayCurrency) ?? CURRENCY_OPTIONS[0];
  const compactForViewport = (value: number) => fmtMoneyAdaptive(value, curSymbol);
  const fmtCur = (usd: number) => compactForViewport(usd * curRate);
  const fmtPlan = (n: number) => compactForViewport(n);
  // 当前资产可手动覆盖：默认取真实净资产（按默认/主货币），用户改了则以其为准
  const savedCurrent = lsGet("fire:fire-current-ovr", "");
  const [currentInput, setCurrentInput] = useState(() => savedCurrent || String(Math.round(currentAssets * baseRate)));
  const currentDirty = useRef(Boolean(savedCurrent && Number(savedCurrent) !== 0));
  const effCurUsd = currentDirty.current && Number(currentInput) > 0 ? Number(currentInput) / (baseRate || 1) : currentAssets;
  const curAssets = effCurUsd * curRate;
  const curCost = costAssets * baseRate; // 主货币：总成本/原始资产
  // 未手改时把「当前资产」同步为默认/主货币值（显示换算由 curAssets 承担）
  useEffect(() => { if (!currentDirty.current) setCurrentInput(String(Math.round(currentAssets * baseRate))); }, [currentAssets, baseRate]);
  useEffect(() => { if (currentDirty.current) lsSet("fire:fire-current-ovr", currentInput); }, [currentInput]);
  // FIRE 目标按「默认/主货币」原值保存，避免先换成 USD 后因汇率更新产生 3000000 → 3000937 漂移。
  const defaultTargetBase = annualExpense > 0 ? annualExpense / (withdrawalRate / 100) : 0;
  const savedTargetBase = Number(lsGet("fire:fire-target-base", ""));
  const savedTargetUsd = Number(lsGet("fire:fire-target-usd", ""));
  const [fireTargetBase, setFireTargetBase] = useState<number>(() => savedTargetBase > 0
    ? savedTargetBase
    : savedTargetUsd > 0
      ? normalizeLegacyFireTarget(savedTargetUsd * (baseRate || 1))
      : defaultTargetBase);
  const fireTargetTouched = useRef(savedTargetBase > 0 || savedTargetUsd > 0);
  useEffect(() => {
    if (!fireTargetTouched.current) setFireTargetBase(defaultTargetBase);
  }, [defaultTargetBase]);
  useEffect(() => { lsSet("fire:fire-target-base", String(fireTargetBase)); }, [fireTargetBase]);
  const fireTargetUsd = fireTargetBase / (baseRate || 1);
  const effTargetDisplay = fireTargetUsd * curRate; // 显示币种的 FIRE 目标（表格/汇总分母）

  const progress = fireTargetUsd > 0 ? (effCurUsd / fireTargetUsd) * 100 : 0;
  const passiveIncome = (curAssets * withdrawalRate) / 100;
  // 顶部 3 个汇总值：未手动改时跟随计算值，改了才固定（且持久化）
  const savedPassive = lsGet("fire:fire-passive", "");
  const savedOriginal = lsGet("fire:fire-original", "");
  const savedYears = lsGet("fire:fire-years", "");
  const [passiveInput, setPassiveInput] = useState(() => savedPassive || String(Math.round(passiveIncome)));
  const [originalInput, setOriginalInput] = useState(() => savedOriginal || String(Math.round(curCost)));
  const [yearsInput, setYearsInput] = useState(() => savedYears || "");
  // 仅当保存的是「非零的真实编辑」才视为用户改过；旧的 0/空缓存视为未改，触发按实时重算
  const passiveDirty = useRef(Boolean(savedPassive && Number(savedPassive) !== 0));
  const originalDirty = useRef(Boolean(savedOriginal && Number(savedOriginal) !== 0));
  const yearsDirty = useRef(Boolean(savedYears && Number(savedYears) !== 0));
  useEffect(() => { if (!passiveDirty.current) setPassiveInput(String(Math.round(passiveIncome))); }, [passiveIncome]);
  useEffect(() => { if (!originalDirty.current) setOriginalInput(String(Math.round(curCost))); }, [curCost]);
  useEffect(() => { if (passiveDirty.current) lsSet("fire:fire-passive", passiveInput); }, [passiveInput]);
  useEffect(() => { if (originalDirty.current) lsSet("fire:fire-original", originalInput); }, [originalInput]);
  useEffect(() => { if (yearsDirty.current) lsSet("fire:fire-years", yearsInput); }, [yearsInput]);
  const clampedProgress = Math.min(Math.max(progress, 0), 100);
  // 水球液面：随 FIRE 进度升高（0% 空、100% 满）
  const waterY = 192 - (clampedProgress / 100) * 184;
  // 读数居中于「水」的纵向中点（随水位移动）
  const waterCenterPt = ((waterY + 192) / 2 / 200) * 100;
  // 每年明细：编辑态下列列都可改；今年预填真实账户（成本/市值/盈利/收益率/进度）
  const savedTableRaw = lsGet("fire:fire-table", "");
  const [tableRows, setTableRows] = useState<{ year: number; original: string; current: string; extra: string; profit: string; rate: string; target: string; progress: string }[]>(() => {
    if (savedTableRaw) {
      try {
        const parsed = JSON.parse(savedTableRaw);
        if (Array.isArray(parsed) && parsed.length) {
          const arr = parsed as { year: number; original: string; current: string; extra?: string; profit: string; rate: string; target?: string; progress: string }[];
          // 默认只保留 2026–2030（至少 5 行）；若你手动填了更远年份则保留到最后一个有数据的年份
          const lastFilled = arr.reduce((acc, r, i) => (r.current || r.original || r.extra || r.profit || r.rate ? i : acc), -1);
          const keep = Math.max(5, lastFilled + 1);
          return arr.slice(0, keep).map((r) => ({ ...r, extra: r.extra ?? "", target: r.target ?? String(round2(fireTargetBase)) }));
        }
      } catch { /* 忽略 */ }
    }
    const y = new Date().getFullYear();
    const net = effCurUsd * baseRate;       // 主货币：当前资产（与上方一致）
    const cost = curCost;                   // 主货币：原始资产
    const profit = net - cost;
    const rate = cost > 0 ? (profit / cost) * 100 : 0;
    const targetBase = fireTargetUsd * baseRate;
    const pct = targetBase > 0 ? (net / targetBase) * 100 : 0;
    const list = [{ year: y, original: String(round2(cost)), current: String(round2(net)), extra: "", profit: String(round2(profit)), rate: String(round2(rate)), target: String(round2(targetBase)), progress: String(round2(pct)) }];
    for (let i = 1; i <= 4; i++) list.push({ year: y + i, original: "", current: "", extra: "", profit: "", rate: "", target: String(round2(targetBase)), progress: "" });
    return list;
  });
  const currentYear = new Date().getFullYear();
  // 还需年数：从手填表格推导（当前资产 ÷ FIRE目标 ≥100% 的第一个年份）；未达成则为 null（保留用户填/占位）
  const tableYearsToFire = useMemo(() => {
    const idx = tableRows.findIndex((r) => Number(r.current) > 0 && Number(r.target) > 0 && (Number(r.current) / Number(r.target)) * 100 >= 100);
    if (idx < 0) return null;
    return tableRows[idx].year - currentYear;
  }, [tableRows, currentYear]);
  useEffect(() => {
    if (!yearsDirty.current && tableYearsToFire != null) setYearsInput(String(tableYearsToFire));
  }, [tableYearsToFire]);
  // 今年的行始终按真实账户数据重算（仅会话内可临时改），不因持久化而冻结
  const currentRowTouched = useRef(false);
  const tableDirty = useRef(Boolean(savedTableRaw));
  const updateRow = (year: number, key: "original" | "current" | "extra" | "profit" | "rate" | "target" | "progress", value: string) => {
    tableDirty.current = true;
    if (year === currentYear && key !== "target") currentRowTouched.current = true;
    if (year === currentYear && key === "target") {
      fireTargetTouched.current = true;
      setFireTargetBase(Number(value) || 0);
    }
    setTableRows((prev) => prev.map((r) => {
      if (r.year === year) return { ...r, [key]: value };
      // 下一自然年若仍沿用本年旧目标，则同步继承新值；已单独设置的目标不覆盖。
      if (year === currentYear && key === "target" && r.year === currentYear + 1 && Number(r.target) === fireTargetBase) {
        return { ...r, target: value };
      }
      return r;
    }));
  };
  const updateAnnualFireTarget = (value: number) => {
    fireTargetTouched.current = true;
    setFireTargetBase(value);
    tableDirty.current = true;
    setTableRows((prev) => prev.map((r) => {
      if (r.year === currentYear) return { ...r, target: String(value) };
      if (r.year === currentYear + 1 && Number(r.target) === fireTargetBase) return { ...r, target: String(value) };
      return r;
    }));
  };
  // 追加一年（默认只到 2030，点加号往后扩；上限 currentYear+40）
  const addYear = () => {
    setTableRows((prev) => {
      const present = new Set(prev.map((r) => r.year));
      let nextYear = currentYear;
      while (present.has(nextYear) && nextYear <= currentYear + 40) nextYear++;
      if (nextYear > currentYear + 40) return prev;
      return [...prev, { year: nextYear, original: "", current: "", extra: "", profit: "", rate: "", target: String(round2(fireTargetBase)), progress: "" }];
    });
    tableDirty.current = true;
  };
  // 删除某一年（至少保留一行；当前年不可删）
  const removeYear = (year: number) => {
    if (year === currentYear) return;
    setTableRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.year !== year)));
    tableDirty.current = true;
  };
  const [editing, setEditing] = useState(false);
  // 进入编辑时快照整份可编辑状态，取消时还原（不落库）
  const editSnapshot = useRef<{
    annualExpense: number; withdrawalRate: number; annualReturn: number; inflation: number; savingsRate: number;
    fireTargetBase: number; currentInput: string; passiveInput: string; originalInput: string; yearsInput: string;
    displayCurrency: CurrencyCode;
    tableRows: typeof tableRows;
    dirty: { current: boolean; passive: boolean; original: boolean; years: boolean; table: boolean; currentRow: boolean; fireTarget: boolean };
  } | null>(null);
  function startEdit() {
    editSnapshot.current = {
      annualExpense, withdrawalRate, annualReturn, inflation, savingsRate,
      fireTargetBase, currentInput, passiveInput, originalInput, yearsInput,
      displayCurrency,
      tableRows: structuredClone(tableRows),
      dirty: {
        current: currentDirty.current, passive: passiveDirty.current, original: originalDirty.current,
        years: yearsDirty.current, table: tableDirty.current, currentRow: currentRowTouched.current, fireTarget: fireTargetTouched.current
      }
    };
    setEditing(true);
  }
  function cancelEdit() {
    const s = editSnapshot.current;
    if (s) {
      setAnnualExpense(s.annualExpense); setWithdrawalRate(s.withdrawalRate); setAnnualReturn(s.annualReturn);
      setInflation(s.inflation); setSavingsRate(s.savingsRate); setFireTargetBase(s.fireTargetBase);
      setCurrentInput(s.currentInput); setPassiveInput(s.passiveInput); setOriginalInput(s.originalInput); setYearsInput(s.yearsInput);
      setDisplayCurrency(s.displayCurrency); setTableRows(s.tableRows);
      currentDirty.current = s.dirty.current; passiveDirty.current = s.dirty.passive; originalDirty.current = s.dirty.original;
      yearsDirty.current = s.dirty.years; tableDirty.current = s.dirty.table; currentRowTouched.current = s.dirty.currentRow;
      fireTargetTouched.current = s.dirty.fireTarget;
    }
    setEditing(false);
  }
  useEffect(() => { if (tableDirty.current) lsSet("fire:fire-table", JSON.stringify(tableRows)); }, [tableRows]);
  // 今年这一行预填真实账户数据；用户一旦手动改过就不再覆盖
  useEffect(() => {
    if (currentRowTouched.current) return;
    setTableRows((prev) => prev.map((r) => {
      if (r.year !== currentYear) return r;
      const netBase = effCurUsd * baseRate;          // 主货币：当前资产（与上方「当前资产」一致，含手动覆盖）
      const costBase = costAssets * baseRate;        // 主货币：原始资产
      const profitBase = netBase - costBase;
      const rate = costBase > 0 ? (profitBase / costBase) * 100 : 0;
      const targetBase = Number(r.target) > 0 ? Number(r.target) : fireTargetUsd * baseRate;
      const pct = targetBase > 0 ? (netBase / targetBase) * 100 : 0;
      return { ...r, original: String(round2(costBase)), current: String(round2(netBase)), profit: String(round2(profitBase)), rate: String(round2(rate)), progress: String(round2(pct)) };
    }));
  }, [effCurUsd, currentAssets, costAssets, fireTargetUsd, baseRate, currentYear]);

  // —— 跨设备同步：把 FIRE 手填配置存到服务端（按用户），登录同一账号任何设备一致 ——
  const [serverLoaded, setServerLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/v1/fire-settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        if (d?.fire && typeof d.fire === "object") {
          const f = d.fire as Record<string, unknown>;
          if (typeof f.annualExpense === "number") setAnnualExpense(Number(f.annualExpense) || annualExpense);
          if (typeof f.withdrawalRate === "number") setWithdrawalRate(Number(f.withdrawalRate) || withdrawalRate);
          if (typeof f.annualReturn === "number") setAnnualReturn(Number(f.annualReturn) || annualReturn);
          if (typeof f.inflation === "number") setInflation(Number(f.inflation) || inflation);
          if (typeof f.savingsRate === "number") setSavingsRate(Number(f.savingsRate) || savingsRate);
          const loadedBaseCurrency = CURRENCIES.some((currency) => currency.code === String(f.baseCurrency))
            ? String(f.baseCurrency)
            : baseCurrency;
          if (Number(f.fireTargetBase) > 0) {
            setFireTargetBase(Number(f.fireTargetBase));
            fireTargetTouched.current = true;
          } else if (Number(f.fireTargetUsd) > 0) {
            const legacyRate = rates[loadedBaseCurrency] || FALLBACK_RATES[loadedBaseCurrency] || 1;
            setFireTargetBase(normalizeLegacyFireTarget(Number(f.fireTargetUsd) * legacyRate));
            fireTargetTouched.current = true;
          }
          if (typeof f.currentInput === "string" && f.currentInput !== "") { setCurrentInput(f.currentInput); currentDirty.current = true; }
          if (typeof f.passiveInput === "string" && f.passiveInput !== "") { setPassiveInput(f.passiveInput); passiveDirty.current = true; }
          if (typeof f.originalInput === "string" && f.originalInput !== "") { setOriginalInput(f.originalInput); originalDirty.current = true; }
          if (typeof f.yearsInput === "string" && Number(f.yearsInput) !== 0) { setYearsInput(f.yearsInput); yearsDirty.current = true; }
          if (Array.isArray(f.tableRows)) {
            const loadedRows = (f.tableRows as { year: number; original: string; current: string; extra?: string; profit: string; rate: string; target?: string; progress: string }[])
              .map((r) => ({ ...r, extra: r.extra ?? "", target: r.target ?? String(round2(Number(f.fireTargetBase) || fireTargetBase)) }));
            setTableRows(loadedRows);
            const thisYearTarget = Number(loadedRows.find((r) => r.year === currentYear)?.target);
            if (thisYearTarget > 0) setFireTargetBase(thisYearTarget);
          }
          if (CURRENCIES.some((c) => c.code === f.displayCurrency)) setDisplayCurrency(f.displayCurrency as CurrencyCode);
          if (CURRENCIES.some((c) => c.code === f.baseCurrency)) setBaseCurrency(f.baseCurrency as CurrencyCode);
        }
        setServerLoaded(true);
      })
      .catch(() => {});
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 【跨年落账】检测到新年（比上次结算年大）时，把刚结束的那一年用当前实时值快照固化
  const lastSettledRef = useRef<number>(Number(lsGet("fire:fire-settled", "0")) || 0);
  useEffect(() => {
    if (!serverLoaded || !records || records.length === 0) return;
    if (currentYear <= lastSettledRef.current) return;
    setTableRows((prev) => {
      const frozen = prev.map((r) => {
      if (r.year !== currentYear - 1) return r;
      const netBase = currentAssets * baseRate;   // 主货币：该年结束时的当前资产
      const costBase = curCost;                   // 主货币：该年原始资产
      const profitBase = netBase - costBase;
      const rate = costBase > 0 ? (profitBase / costBase) * 100 : 0;
      const targetBase = Number(r.target) > 0 ? Number(r.target) : fireTargetUsd * baseRate;
      const pct = targetBase > 0 ? (netBase / targetBase) * 100 : 0;
      return { ...r, original: String(round2(costBase)), current: String(round2(netBase)), profit: String(round2(profitBase)), rate: String(round2(rate)), target: String(round2(targetBase)), progress: String(round2(pct)) };
      });
      if (frozen.some((r) => r.year === currentYear)) return frozen;
      const previousTarget = frozen.find((r) => r.year === currentYear - 1)?.target || String(round2(fireTargetBase));
      return [...frozen, {
        year: currentYear,
        original: String(round2(curCost)),
        current: String(round2(currentAssets * baseRate)),
        extra: "",
        profit: String(round2(currentAssets * baseRate - curCost)),
        rate: curCost > 0 ? String(round2(((currentAssets * baseRate - curCost) / curCost) * 100)) : "0",
        target: previousTarget,
        progress: Number(previousTarget) > 0 ? String(round2((currentAssets * baseRate / Number(previousTarget)) * 100)) : "0"
      }];
    });
    lsSet("fire:fire-settled", String(currentYear - 1));
    lastSettledRef.current = currentYear - 1;
  }, [serverLoaded, records, currentYear, currentAssets, costAssets, fireTargetUsd, baseRate, curCost]);

  // 防抖保存：任一配置变化后 600ms 写回服务端
  useEffect(() => {
    if (!serverLoaded || editing) return;
    const t = setTimeout(() => {
      const payload = { annualExpense, withdrawalRate, annualReturn, inflation, savingsRate, fireTargetBase, fireTargetUsd, currentInput: currentDirty.current ? currentInput : null, passiveInput, originalInput, yearsInput, displayCurrency, baseCurrency, tableRows };
      fetch("/api/v1/fire-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fire: payload }) }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [serverLoaded, editing, annualExpense, withdrawalRate, annualReturn, inflation, savingsRate, fireTargetBase, fireTargetUsd, currentInput, passiveInput, originalInput, yearsInput, displayCurrency, baseCurrency, tableRows]);

  const inputCls =
    "w-full rounded-lg border border-edge bg-white px-2.5 py-1.5 text-sm text-ink-2 outline-none transition-colors focus:border-brand dark:border-edge-strong dark:bg-[#1c1c1e] dark:text-white";
  const labelCls = "mb-1 block text-xs font-medium text-muted";
  const thCls =
    "px-3 py-2 text-left text-xs font-semibold text-muted whitespace-nowrap";
  const tdCls =
    "px-3 py-2.5 text-sm tabular-nums text-ink-2 dark:text-white whitespace-nowrap";
  const cellCls =
    "w-[130px] rounded-md border border-edge bg-white/80 px-2 py-1 text-right text-sm tabular-nums text-ink-2 outline-none transition-colors focus:border-brand dark:border-edge-strong dark:bg-[#1c1c1e] dark:text-white";

  if (!hydrated) {
    return <div className="fire-page mx-auto min-h-[720px] max-w-[980px] px-4 py-8" aria-hidden="true" />;
  }

  return (
    <div className="fire-page mx-auto max-w-[980px] px-4 py-8">
      <style>{fireCss}</style>
      {/* 页头：整页 只读 ↔ 编辑 统一开关 */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <b className="fire-glowmark">fire</b>
          <span className="text-sm font-medium text-muted">退休规划</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOceanSceneEnabled((enabled) => !enabled)}
            aria-pressed={oceanSceneEnabled}
            aria-label={oceanSceneEnabled ? "切换为仅显示圆球" : "显示海洋场景"}
            title={oceanSceneEnabled ? "仅显示圆球" : "显示海洋场景"}
            className={`fire-scene-switch inline-flex h-8 w-8 items-center justify-center rounded-full border ${oceanSceneEnabled ? "border-[#36bdc8]/55 bg-[#0bb4b4]/10 text-[#26b8c5] shadow-[0_0_13px_rgba(11,180,180,.18)]" : "border-edge bg-white text-muted hover:bg-bg-gray dark:border-edge-strong dark:bg-[#1c1c1e] dark:hover:bg-[#26282e]"}`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M3 8.5c1.5 0 1.5 1.3 3 1.3s1.5-1.3 3-1.3 1.5 1.3 3 1.3 1.5-1.3 3-1.3 1.5 1.3 3 1.3 1.5-1.3 3-1.3" />
              <path d="M3 13c1.5 0 1.5 1.3 3 1.3s1.5-1.3 3-1.3 1.5 1.3 3 1.3 1.5-1.3 3-1.3 1.5 1.3 3 1.3 1.5-1.3 3-1.3" />
              <path d="M5 17.5h14" opacity={oceanSceneEnabled ? 1 : .35} />
              {!oceanSceneEnabled && <path d="M4 4l16 16" strokeWidth="2.1" />}
            </svg>
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setCurrencyMenuOpen((o) => !o)}
              aria-expanded={currencyMenuOpen}
              title="切换显示币种"
              className="fire-currency-switch inline-flex h-8 w-8 items-center justify-center rounded-full border border-edge bg-white dark:border-edge-strong dark:bg-[#1c1c1e] dark:hover:bg-[#26282e]"
            >
              <CurrencyFlag market={curOption.market} size={18} />
            </button>
            {currencyMenuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setCurrencyMenuOpen(false)} />
                <div className="absolute right-0 top-full z-40 mt-1 min-w-[180px] overflow-hidden rounded-xl border border-edge-strong bg-white p-1.5 shadow-pop dark:border-edge-strong dark:bg-[#1c1c1e]">
                  {CURRENCY_OPTIONS.map((option) => (
                    <div key={option.value} className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition ${displayCurrency === option.value ? "bg-[#0bb4b4]/10" : "hover:bg-bg-gray dark:hover:bg-white/5"}`}>
                      <button
                        type="button"
                        onClick={() => {
                          setDisplayCurrency(option.value);
                          setCurrencyMenuOpen(false);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-xs"
                      >
                        <CurrencyFlag market={option.market} size={15} />
                        <span className={`truncate ${displayCurrency === option.value ? "font-bold text-[#0bb4b4]" : "font-medium text-ink dark:text-white"}`}>{option.code} {option.label}</span>
                      </button>
                      <button
                        type="button"
                        title={baseCurrency === option.value ? "当前默认/主货币" : "设为默认/主货币"}
                        onClick={() => {
                          updateAnnualFireTarget(round2(fireTargetUsd * (rates[option.value] || 1)));
                          setBaseCurrency(option.value);
                          try { localStorage.setItem("fire:base-currency", option.value); } catch { /* 忽略 */ }
                          setCurrencyMenuOpen(false);
                        }}
                        className={`flex h-6 w-6 flex-none items-center justify-center rounded-full transition-colors ${baseCurrency === option.value ? "text-emerald-500" : "text-muted hover:text-emerald-500"}`}
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill={baseCurrency === option.value ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9Z" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => (editing ? setEditing(false) : startEdit())}
              className={`fire-edit-button inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium ${editing ? "fire-save-btn text-white" : "border border-edge bg-white text-ink-2 hover:bg-bg-gray dark:border-edge-strong dark:bg-[#1c1c1e] dark:text-white dark:hover:bg-[#26282e]"}`}
            >
              {editing ? "保存" : "编辑"}
            </button>
            {editing && (
              <button
                type="button"
                onClick={cancelEdit}
                title="放弃修改，回到上次保存的状态"
                className="fire-cancel-btn inline-flex h-8 items-center gap-1.5 rounded-full border border-transparent bg-white px-3.5 text-sm font-medium text-ink-2 hover:bg-[#f5f6f8] hover:text-[#e5484d] dark:border-edge-strong dark:bg-[#1c1c1e] dark:text-white dark:hover:bg-[#26282e]"
              >
                取消
              </button>
            )}
          </div>
        </div>
      </div>
      {/* 顶部圆气泡：Apple 风格玻璃水球，水位随 FIRE 进度升降、缓慢呼吸 */}
      <div className="mb-10 flex flex-col items-center">
        <div className="fire-bubble-scene relative flex w-full items-center justify-center">
          {oceanSceneEnabled && (
            <>
              <OceanAmbient />
              <ClownfishFamily />
              <GlassFishRefraction />
            </>
          )}
        <div
          className="fire-bubble relative z-10 h-[248px] w-[248px]"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setBubbleHover({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
          }}
          onMouseLeave={() => setBubbleHover(null)}
        >
          {/* 环境柔光 */}
          <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_50%_32%,rgba(11,180,180,.22),rgba(18,115,230,.10)_55%,transparent_72%)] blur-2xl" />
          <svg viewBox="0 0 200 200" className="relative h-full w-full">
            <defs>
              <clipPath id="fireBubbleClip"><circle cx="100" cy="100" r="92" /></clipPath>
              <linearGradient id="fireWater" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#22e0e8" />
                <stop offset="0.5" stopColor="#2fa0f2" />
                <stop offset="1" stopColor="#1e5cd6" />
              </linearGradient>
              <radialGradient id="fireBloom" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0" stopColor="rgba(255,255,255,.5)" />
                <stop offset="0.55" stopColor="rgba(255,255,255,.16)" />
                <stop offset="1" stopColor="rgba(255,255,255,0)" />
              </radialGradient>
              <radialGradient id="fireGlass" cx="0.5" cy="0.2" r="0.9">
                <stop offset="0" stopColor="rgba(255,255,255,.06)" />
                <stop offset="1" stopColor="rgba(255,255,255,0)" />
              </radialGradient>
              <filter id="fireBlur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.5" /></filter>
            </defs>
            {/* 玻璃底盘（深浅模式自适应） */}
            <circle cx="100" cy="100" r="92" className="fill-white/35 dark:fill-[#1b212a]/55" />
            <circle cx="100" cy="100" r="92" fill="url(#fireGlass)" />
            {/* 液体：水位 = FIRE 进度，缓慢涌动 + 呼吸起伏 */}
            <g clipPath="url(#fireBubbleClip)">
              <g className="fire-liquid">
                <path className="fire-wave-back" d={wavePath(waterY, { amp: 6, phase: 24, x0: -176, x1: 376 })} fill="url(#fireWater)" opacity=".26" />
                <path className="fire-wave" d={wavePath(waterY)} fill="url(#fireWater)" opacity=".96" />
                <path fill="none" stroke="rgba(255,255,255,.68)" strokeWidth="1.3" d={wavePath(waterY - 0.6, { amp: 5, x0: -144, x1: 336 })} opacity=".8" />
                {/* 阳光进入水面的柔光 */}
                <ellipse cx="100" cy={waterY + 2} rx="38" ry="12" fill="url(#fireBloom)" opacity=".6" />
                <ellipse cx="100" cy={waterY + 9} rx="58" ry="16" fill="url(#fireBloom)" opacity=".22" filter="url(#fireBlur)" />
              </g>
              {/* 水下：入水后折射弯曲的阳光束 */}
              <g className="fire-rays" filter="url(#fireBlur)" opacity=".5">
                <path d={`M100 ${waterY} C90 ${waterY + 34} 56 ${waterY + 52} 48 ${waterY + 100} L80 ${waterY + 100} C86 ${waterY + 52} 120 ${waterY + 34} 112 ${waterY} Z`} fill="rgba(255,255,255,.13)" />
                <path d={`M100 ${waterY} C100 ${waterY + 40} 100 ${waterY + 72} 100 ${waterY + 100} L124 ${waterY + 100} C118 ${waterY + 72} 116 ${waterY + 40} 112 ${waterY} Z`} fill="rgba(255,255,255,.10)" />
                <path d={`M100 ${waterY} C108 ${waterY + 34} 140 ${waterY + 52} 152 ${waterY + 100} L128 ${waterY + 100} C122 ${waterY + 52} 106 ${waterY + 34} 92 ${waterY} Z`} fill="rgba(255,255,255,.07)" />
              </g>
              {/* 焦散光斑（底部随波漂移） */}
              <g className="fire-caustics">
                <ellipse cx="62" cy="176" rx="26" ry="8" fill="rgba(255,255,255,.20)" filter="url(#fireBlur)" />
                <ellipse cx="122" cy="158" rx="20" ry="6" fill="rgba(190,230,255,.16)" filter="url(#fireBlur)" />
                <ellipse cx="88" cy="188" rx="32" ry="9" fill="rgba(255,255,255,.17)" filter="url(#fireBlur)" />
                <ellipse cx="40" cy="150" rx="14" ry="5" fill="rgba(255,255,255,.12)" filter="url(#fireBlur)" />
                <ellipse cx="150" cy="182" rx="16" ry="6" fill="rgba(190,230,255,.14)" filter="url(#fireBlur)" />
              </g>
              {/* 顶部细碎焦散（快速漂移） */}
              <g className="fire-caustics-b">
                <ellipse cx="70" cy="120" rx="16" ry="4" fill="rgba(255,255,255,.10)" filter="url(#fireBlur)" />
                <ellipse cx="120" cy="132" rx="14" ry="4" fill="rgba(255,255,255,.09)" filter="url(#fireBlur)" />
                <ellipse cx="95" cy="112" rx="18" ry="5" fill="rgba(200,235,255,.08)" filter="url(#fireBlur)" />
              </g>
              {/* 上升的小气泡 */}
              <g className="fire-bubbles">
                <circle cx="78" cy="184" r="1.6" fill="rgba(255,255,255,.3)" />
                <circle cx="120" cy="190" r="1.3" fill="rgba(255,255,255,.28)" />
                <circle cx="99" cy="176" r="1.9" fill="rgba(255,255,255,.26)" />
                <circle cx="133" cy="170" r="1.4" fill="rgba(255,255,255,.3)" />
              </g>
              {/* 水面细碎涟漪（柔光游走） */}
              <g className="fire-ripples" stroke="rgba(255,255,255,.4)" fill="none" strokeLinecap="round" opacity=".7">
                <path d={`M58 ${waterY - 2} C66 ${waterY - 4} 76 ${waterY - 3} 84 ${waterY - 2}`} strokeWidth="1.1" />
                <path d={`M114 ${waterY - 1} C122 ${waterY - 3} 130 ${waterY - 2} 140 ${waterY - 1}`} strokeWidth="1" />
                <path d={`M86 ${waterY + 4} C94 ${waterY + 2} 102 ${waterY + 3} 110 ${waterY + 4}`} strokeWidth="0.9" />
              </g>
              {/* 金额 & 进度的水面倒影（模糊、倒置，随水位移动） */}
              <g transform={`translate(100, ${waterY}) scale(1, -1)`} opacity=".28" filter="url(#fireBlur)">
                <text x="0" y="-5" textAnchor="middle" fill="#fff" fontSize="15" fontWeight="600">{fmtCur(effCurUsd)}</text>
                <text x="0" y="-18" textAnchor="middle" fill="#fff" fontSize="11" fontWeight="600">{progress.toFixed(1)}%</text>
              </g>
            </g>
            {/* 玻璃壁 */}
            <circle cx="100" cy="100" r="92" fill="none" className="stroke-[#c6ccd7]/55 dark:stroke-white" strokeWidth="1.4" />
            <circle cx="100" cy="100" r="92" fill="none" stroke="rgba(10,20,40,.05)" strokeWidth="6" opacity="0.35" />
            {/* 玻璃球高光（左上弧光） */}
            <path d="M 30 50 A 88 88 0 0 1 96 16" fill="none" stroke="rgba(255,255,255,.62)" strokeWidth="3" strokeLinecap="round" filter="url(#fireBlur)" opacity=".85" />
            <path d="M 24 60 A 76 76 0 0 1 78 22" fill="none" stroke="rgba(255,255,255,.3)" strokeWidth="1.6" strokeLinecap="round" />
            {/* 内沿柔光 */}
            <circle cx="100" cy="100" r="88" fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="5" />
          </svg>
          {/* 中心读数：上面金额、下面进度，居中在水区域内（随水位移动） */}
          <div className="absolute inset-0">
            <div className="absolute left-1/2" style={{ top: `${waterCenterPt}%`, transform: "translate(-50%, -50%)" }}>
              <div
                className="relative flex flex-col items-center text-center"
                style={{ textShadow: "0 1px 6px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.4)" }}
              >
                <span className="relative text-[24px] font-semibold tabular-nums leading-none tracking-tight text-white">{fmtCur(effCurUsd)}</span>
                <span className="relative mt-1.5 text-[18px] font-semibold leading-none tabular-nums text-white">
                  {progress.toFixed(1)}<span className="text-[14px] text-white/85">%</span>
                </span>
              </div>
            </div>
          </div>
          {/* 鼠标划过水面的柔光涟漪（跟随光标） */}
          {bubbleHover && (
            <div
              className="pointer-events-none absolute z-20 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/20 blur-2xl transition-all duration-150"
              style={{ left: `${bubbleHover.x * 100}%`, top: `${bubbleHover.y * 100}%` }}
            />
          )}
        </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className={labelCls}>{currentYear} FIRE 目标</label>
            {editing ? (
              <input type="number" value={round2(fireTargetBase)} onChange={(e) => updateAnnualFireTarget(Number(e.target.value) || 0)} className={inputCls} />
            ) : (
              <div className="text-[20px] font-semibold leading-tight tabular-nums text-ink-2 dark:text-white">{fmtPlan(effTargetDisplay)}</div>
            )}
          </div>
          <div>
            <label className={labelCls}>年被动收入</label>
            {editing ? (
              <input type="number" value={passiveInput} onChange={(e) => { passiveDirty.current = true; setPassiveInput(e.target.value); }} className={inputCls} />
            ) : (
              <div className="text-[20px] font-semibold leading-tight tabular-nums text-ink-2 dark:text-white">{fmtPlan(Number(passiveInput) || 0)}</div>
            )}
          </div>
          <div>
            <label className={labelCls}>当前资产</label>
            {editing ? (
              <div className="flex items-center gap-1">
                <input type="number" value={currentInput} onChange={(e) => { currentDirty.current = true; setCurrentInput(e.target.value); }} className={inputCls} />
                {currentDirty.current && (
                  <button
                    type="button"
                    onClick={() => { currentDirty.current = false; setCurrentInput(String(Math.round(currentAssets * baseRate))); }}
                    title="恢复为真实资产"
                    className="flex-none rounded-md border border-edge px-2 py-1 text-[11px] text-muted transition-colors hover:border-edge-strong hover:text-ink-2 dark:border-edge-strong"
                  >
                    真实
                  </button>
                )}
              </div>
            ) : (
              <div className="text-[20px] font-semibold leading-tight tabular-nums text-ink-2 dark:text-white">{fmtPlan(curAssets)}</div>
            )}
          </div>
          <div>
            <label className={labelCls}>还需年数</label>
            {editing ? (
              <input type="number" value={yearsInput} onChange={(e) => { yearsDirty.current = true; setYearsInput(e.target.value); }} className={inputCls} />
            ) : (
              <div className="text-[20px] font-semibold leading-tight tabular-nums text-ink-2 dark:text-white">{Number(yearsInput) <= 0 ? "已达成" : `${Number(yearsInput)} 年`}</div>
            )}
          </div>
        </div>
      </div>

      {/* 参数（Notion 风，简洁输入） */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ["年支出", annualExpense, setAnnualExpense],
          ["提款率 %", withdrawalRate, setWithdrawalRate],
          ["年化回报 %", annualReturn, setAnnualReturn],
          ["通胀 %", inflation, setInflation],
          ["储蓄率 %", savingsRate, setSavingsRate]
        ].map(([label, val, setter]) => (
          <div key={label as string}>
            <label className={labelCls}>{label as string}</label>
            {editing ? (
              <input type="number"
                value={val as number}
                onChange={(e) => (setter as (v: number) => void)(Number(e.target.value))}
                className={inputCls}
              />
            ) : (
              <div className="text-lg font-semibold tabular-nums text-ink-2 dark:text-white">{val as number}</div>
            )}
          </div>
        ))}
      </div>

      {/* 每年明细表 */}
      <div className="fire-yearly-table overflow-hidden rounded-xl border border-edge bg-white dark:border-edge-strong dark:bg-[#16181c]">
        <div className="data-table-scroll">
          <table className="w-full min-w-[860px] border-collapse">
            <thead>
              <tr className="border-b border-edge bg-bg-gray dark:border-edge-strong dark:bg-[#202328]">
                <th className={thCls}>日期</th>
                <th className={`${thCls} text-right`}>原始资产</th>
                <th className={`${thCls} text-right`}>追加投入</th>
                <th className={`${thCls} text-right`}>累计投入</th>
                <th className={`${thCls} text-right`}>当前资产</th>
                <th className={`${thCls} text-right`}>盈利总额</th>
                <th className={`${thCls} text-right`}>收益率</th>
                <th className={`${thCls} text-right`}>目标资产</th>
                <th className={`${thCls} text-right`}>当前进度</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => {
                const num = (s: string) => (s === "" ? null : Number(s));
                // 表格里存的是主货币值，展示时换算到显示币种
                const money = (s: string) => { const n = num(s); return n != null ? fmtPlan(n * k) : "—"; };
                const isCurYear = row.year === currentYear;
                const isPast = row.year < currentYear; // 已结束年份：冻结不可改
                const origStr = isCurYear ? originalInput : row.original;
                const origN = num(origStr);
                const extraN = num(row.extra);
                const curN = num(row.current);
                const totalInvest = origN != null || extraN != null ? (origN ?? 0) + (extraN ?? 0) : null;
                const profitN = totalInvest != null && curN != null ? curN - totalInvest : null;
                const rateN = totalInvest != null && totalInvest > 0 && profitN != null ? (profitN / totalInvest) * 100 : null;
                const targetBase = Number(row.target) > 0 ? Number(row.target) : fireTargetUsd * baseRate;
                const pctN = curN != null && targetBase > 0 ? (curN / targetBase) * 100 : null;
                const profitDisplay = profitN != null ? (profitN >= 0 ? "+" : "") + fmtPlan(profitN * k) : "—";
                const rateDisplay = rateN != null ? fmtPct2(rateN) : "—";
                const input = (key: "original" | "current" | "extra" | "profit" | "rate" | "target" | "progress") => (
                  <input value={row[key]} onChange={(e) => updateRow(row.year, key, e.target.value)} inputMode="decimal" placeholder="—" className={cellCls} />
                );
                return (
                  <tr key={row.year} className={`border-b border-edge last:border-0 dark:border-edge-strong hover:bg-bg-gray dark:hover:bg-[#202328]`}>
                    <td className={tdCls}>
                      <span className="inline-flex items-center gap-1">
                        {row.year}
                        {isPast && (
                            <span title="自然年结束后，该年度数据不可再修改" className="rounded-full bg-bg-gray px-1.5 py-0.5 text-[9px] font-semibold text-muted dark:bg-white/10 dark:text-white/60">已冻结</span>
                        )}
                        {editing && !isPast && row.year !== currentYear && (
                          <button
                            type="button"
                            onClick={() => removeYear(row.year)}
                            title="删除该年"
                            className="grid h-5 w-5 place-items-center rounded-full text-muted transition-colors hover:bg-[#e5484d]/15 hover:text-[#e5484d]"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3 w-3"><path d="M18 6 6 18M6 6l12 12" /></svg>
                          </button>
                        )}
                      </span>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <span className="text-ink-2 dark:text-white">
                        {editing && !isPast ? (
                          isCurYear ? (
                            <input value={originalInput} onChange={(e) => { originalDirty.current = true; setOriginalInput(e.target.value); }} inputMode="decimal" placeholder="—" className={cellCls} />
                          ) : (
                            input("original")
                          )
                        ) : money(origStr)}
                      </span>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <span className="text-ink-2 dark:text-white">{editing && !isPast ? input("extra") : money(row.extra)}</span>
                    </td>
                    <td className={`${tdCls} text-right`}>{totalInvest != null ? fmtPlan(totalInvest * k) : "—"}</td>
                    <td className={`${tdCls} text-right`}>
                      <span className="text-ink-2 dark:text-white">{editing && !isPast ? input("current") : money(row.current)}</span>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <span className={`${profitN == null || profitN >= 0 ? "text-up" : "text-down"}`}>{profitDisplay}</span>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <span className={`${rateN == null || rateN >= 0 ? "text-up" : "text-down"}`}>{rateDisplay}</span>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      {editing && !isPast ? input("target") : targetBase > 0 ? fmtPlan(targetBase * k) : "—"}
                    </td>
                    <td className={`${tdCls} text-right`}>
                      {pctN != null ? (
                        <div className="ml-auto flex w-[176px] items-center gap-2.5">
                          <div className="fire-progress relative h-[16px] flex-1 overflow-hidden rounded-[8px] border border-[#9aa1ab]/60 bg-[#e9edf2] shadow-[inset_0_1px_2px_rgba(0,0,0,.08)] dark:border-white/30 dark:bg-[#2a2f3a]">
                            <svg viewBox="0 0 100 16" preserveAspectRatio="none" className="absolute inset-[1px] h-[calc(100%-2px)] w-[calc(100%-2px)]">
                              <defs>
                                <linearGradient id={`fbw${row.year}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1be0e8" /><stop offset="1" stopColor="#3f8bff" /></linearGradient>
                                <clipPath id={`fbc${row.year}`}><rect width={Math.min(Math.max(pctN, 0), 100)} height="16" rx="8" /></clipPath>
                              </defs>
                              <g clipPath={`url(#fbc${row.year})`}>
                                <g className="fire-bar-breathe">
                                  <path className="fire-bar-wave-back" d="M-6 16 L-6 1.8 Q 0 0.2 6 1.8 T 18 1.8 T 30 1.8 T 42 1.8 T 54 1.8 T 66 1.8 T 78 1.8 T 90 1.8 T 102 1.8 T 114 1.8 L114 16 Z" fill={`url(#fbw${row.year})`} opacity=".36" />
                                  <g className="fire-bar-wave">
                                    <path d="M0 16 L0 1.8 Q 6 0.2 12 1.8 T 24 1.8 T 36 1.8 T 48 1.8 T 60 1.8 T 72 1.8 T 84 1.8 T 96 1.8 T 108 1.8 L108 16 Z" fill={`url(#fbw${row.year})`} opacity=".9" />
                                    <path fill="none" stroke="rgba(255,255,255,.68)" strokeWidth=".9" d="M0 1.8 Q 6 0.2 12 1.8 T 24 1.8 T 36 1.8 T 48 1.8 T 60 1.8 T 72 1.8 T 84 1.8 T 96 1.8 T 108 1.8" opacity=".8" />
                                  </g>
                                </g>
                              </g>
                            </svg>
                          </div>
                          <span className="w-[46px] shrink-0 text-right text-[12px] font-medium tabular-nums text-ink-2 dark:text-white">{pctN.toFixed(1)}%</span>
                        </div>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {/* 添加年份（默认只到 2030，点加号往后扩） */}
      <div className="fire-year-actions mt-2 flex justify-start">
        <button
          type="button"
          onClick={addYear}
          className="btn btn-ghost btn-sm"
          title="追加年份"
        >
          ＋ 添加年份
        </button>
      </div>
      {/* 汇率信息（右下角）：1 USD = X 显示币种 · 更新于日期 */}
      <div className="mt-3 flex justify-end">
        <span className="text-[12px] tabular-nums text-muted">
          1 USD = {Number(curRate.toFixed(4))} {displayCurrency} · 更新于 {new Date(ratesAt).getFullYear()}.{new Date(ratesAt).getMonth() + 1}.{new Date(ratesAt).getDate()}
        </span>
      </div>
    </div>
  );
}
