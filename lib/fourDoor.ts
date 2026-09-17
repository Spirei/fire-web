/** 四色门转盘：缓动曲线；样式 1 用线上棘轮，样式 2 用珐琅八音盒（合成，不取样原片）。 */

export const TICK_DEG = 22.5;
export const SHORT_TURN_MS = 900;
export const LONG_TURN_MS = 2000;
export const SHORT_EASE = "cubic-bezier(0.25, 0.1, 0.25, 1)";
export const LONG_EASE = "cubic-bezier(0.16, 0.84, 0.18, 1)";

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const err = sampleX(t) - x;
      const d = sampleDX(t);
      if (Math.abs(err) < 1e-6 || Math.abs(d) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - err / d));
    }
    return sampleY(t);
  };
}

export const easeShort = cubicBezier(0.25, 0.1, 0.25, 1);
export const easeLong = cubicBezier(0.16, 0.84, 0.18, 1);

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

export type FourDoorVoice = 1 | 2;

/** 珐琅盘：C 五声拇指琴 + 很轻的齿轮底。 */
const TINES = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66];
const SPIN = [587.33, 659.25, 783.99, 880.0, 1046.5, 880.0, 783.99, 659.25];

export function createFourDoorAudio() {
  let context: AudioContext | null = null;
  let originalOut: GainNode | null = null;
  let enamelOut: GainNode | null = null;
  let lastTickAt = 0;
  let tickIndex = 0;
  let dust: AudioBuffer | null = null;
  let click: AudioBuffer | null = null;

  function ensure() {
    if (typeof window === "undefined") return null;
    if (context && context.state !== "closed") return context;
    const Ctor = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    if (context.state === "suspended") void context.resume();

    const originalComp = context.createDynamicsCompressor();
    originalComp.threshold.value = -16;
    originalComp.knee.value = 5;
    originalComp.ratio.value = 3;
    originalComp.attack.value = 0.001;
    originalComp.release.value = 0.08;
    originalOut = context.createGain();
    originalOut.gain.value = 0.88;
    originalOut.connect(originalComp).connect(context.destination);

    const enamelComp = context.createDynamicsCompressor();
    enamelComp.threshold.value = -22;
    enamelComp.knee.value = 10;
    enamelComp.ratio.value = 1.8;
    enamelComp.attack.value = 0.012;
    enamelComp.release.value = 0.22;
    const air = context.createBiquadFilter();
    air.type = "lowpass";
    air.frequency.value = 3600;
    air.Q.value = 0.4;
    enamelOut = context.createGain();
    enamelOut.gain.value = 0.58;
    enamelOut.connect(air).connect(enamelComp).connect(context.destination);

    const dustN = Math.floor(context.sampleRate * 0.12);
    dust = context.createBuffer(1, dustN, context.sampleRate);
    const dustData = dust.getChannelData(0);
    for (let i = 0; i < dustN; i += 1) dustData[i] = Math.random() * 2 - 1;

    const clickN = Math.floor(context.sampleRate * 0.014);
    click = context.createBuffer(1, clickN, context.sampleRate);
    const clickData = click.getChannelData(0);
    for (let i = 0; i < clickN; i += 1) clickData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / clickN, 6);
    return context;
  }

  function ratchet(ctx: AudioContext, dest: AudioNode, index: number, volume: number, now: number) {
    const i = index % 11;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(690 - i * 18, now);
    osc.frequency.exponentialRampToValueAtTime(410 - i * 10, now + 0.032);
    filter.type = "highpass";
    filter.frequency.value = 360;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    osc.connect(filter).connect(gain).connect(dest);
    osc.start(now);
    osc.stop(now + 0.045);
  }

  function tone(ctx: AudioContext, dest: AudioNode, freq: number, volume: number, attack: number, decay: number, now: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.986), now + attack + decay);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    osc.connect(gain).connect(dest);
    osc.start(now);
    osc.stop(now + attack + decay + 0.04);
  }

  function tine(ctx: AudioContext, dest: AudioNode, freq: number, volume: number, decay: number, now: number) {
    tone(ctx, dest, freq, volume, 0.008, decay, now);
    tone(ctx, dest, freq * 2.003, volume * 0.14, 0.01, decay * 0.45, now);
    tone(ctx, dest, freq * 0.5, volume * 0.22, 0.012, decay * 1.2, now);
  }

  function breath(ctx: AudioContext, dest: AudioNode, volume: number, now: number, dur: number, center: number) {
    if (!dust) return;
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = dust;
    filter.type = "bandpass";
    filter.frequency.value = center;
    filter.Q.value = 1.1;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filter).connect(gain).connect(dest);
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  function beginOriginal() {
    const ctx = ensure();
    if (!ctx || !originalOut) return;
    if (ctx.state === "suspended") void ctx.resume();
    tickIndex = 0;
    lastTickAt = ctx.currentTime;
    ratchet(ctx, originalOut, 0, 0.055, ctx.currentTime + 0.1);
    tickIndex = 1;
  }

  function tickOriginal(velocityDegPerSec: number) {
    const ctx = ensure();
    if (!ctx || !originalOut) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    if (now - lastTickAt < 0.09) return;
    lastTickAt = now;
    const speed = Math.min(1, Math.max(0, (Number.isFinite(velocityDegPerSec) ? velocityDegPerSec : 0) / 640));
    ratchet(ctx, originalOut, tickIndex, 0.04 + (1 - speed) * 0.018, now);
    tickIndex += 1;
  }

  function lockOriginal() {
    const ctx = ensure();
    if (!ctx || !originalOut) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    ([
      [1567.98, 0.22, 0.18],
      [3135.96, 0.11, 0.105],
      [4703.94, 0.052, 0.068],
      [6271.92, 0.022, 0.042]
    ] as const).forEach(([frequency, volume, duration]) => {
      const bell = ctx.createOscillator();
      const gain = ctx.createGain();
      bell.type = "sine";
      bell.frequency.setValueAtTime(frequency, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume, now + 0.0015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      bell.connect(gain).connect(originalOut!);
      bell.start(now);
      bell.stop(now + duration + 0.008);
    });
    if (!click) return;
    const transient = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    transient.buffer = click;
    filter.type = "highpass";
    filter.frequency.value = 4200;
    gain.gain.setValueAtTime(0.075, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.014);
    transient.connect(filter).connect(gain).connect(originalOut);
    transient.start(now);
  }

  function beginEnamel() {
    const ctx = ensure();
    if (!ctx || !enamelOut) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    tickIndex = 0;
    lastTickAt = now;
    breath(ctx, enamelOut, 0.018, now, 0.22, 980);
    tine(ctx, enamelOut, TINES[0], 0.016, 0.42, now);
    tine(ctx, enamelOut, TINES[3], 0.018, 0.5, now + 0.068);
    tine(ctx, enamelOut, TINES[5], 0.014, 0.38, now + 0.138);
    ratchet(ctx, enamelOut, 0, 0.028, now + 0.09);
    tickIndex = 1;
  }

  function tickEnamel(velocityDegPerSec: number) {
    const ctx = ensure();
    if (!ctx || !enamelOut) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    if (now - lastTickAt < 0.072) return;
    lastTickAt = now;
    const speed = Math.min(1, Math.max(0, (Number.isFinite(velocityDegPerSec) ? velocityDegPerSec : 0) / 640));
    const note = SPIN[tickIndex % SPIN.length];
    ratchet(ctx, enamelOut, tickIndex, 0.016 + (1 - speed) * 0.012, now);
    tine(ctx, enamelOut, note, 0.007 + (1 - speed) * 0.01, 0.16 + (1 - speed) * 0.16, now);
    tickIndex += 1;
  }

  function lockEnamel() {
    const ctx = ensure();
    if (!ctx || !enamelOut) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    breath(ctx, enamelOut, 0.012, now, 0.16, 1400);
    ratchet(ctx, enamelOut, tickIndex, 0.02, now);
    tine(ctx, enamelOut, 523.25, 0.02, 0.95, now);
    tine(ctx, enamelOut, 783.99, 0.022, 0.85, now + 0.028);
    tine(ctx, enamelOut, 659.25, 0.014, 0.7, now + 0.09);
    tine(ctx, enamelOut, 1046.5, 0.01, 0.55, now + 0.16);
  }

  function begin(voice: FourDoorVoice = 1) {
    if (voice === 2) beginEnamel();
    else beginOriginal();
  }

  function tick(velocityDegPerSec: number, voice: FourDoorVoice = 1) {
    if (voice === 2) tickEnamel(velocityDegPerSec);
    else tickOriginal(velocityDegPerSec);
  }

  function lock(voice: FourDoorVoice = 1) {
    if (voice === 2) lockEnamel();
    else lockOriginal();
  }

  function stop() {
    const current = context;
    context = null;
    originalOut = null;
    enamelOut = null;
    dust = null;
    click = null;
    lastTickAt = 0;
    tickIndex = 0;
    if (current && current.state !== "closed") void current.close().catch(() => undefined);
  }

  return { begin, tick, lock, stop };
}
