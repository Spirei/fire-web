/** 四色门转盘：缓动曲线，以及开始 / 转动 / 落定三段风铃钟声（合成，不取样原片）。 */

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

const SPARKLE = [783.99, 987.77, 1174.66, 1318.51, 1567.98];

export function createFourDoorAudio() {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let air: BiquadFilterNode | null = null;
  let lastTickAt = 0;
  let sparkleIndex = 0;

  function ensure() {
    if (typeof window === "undefined") return null;
    if (context && context.state !== "closed") return context;
    const Ctor = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    if (context.state === "suspended") void context.resume();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -26;
    compressor.knee.value = 12;
    compressor.ratio.value = 1.6;
    compressor.attack.value = 0.02;
    compressor.release.value = 0.22;
    air = context.createBiquadFilter();
    air.type = "lowpass";
    air.frequency.value = 3200;
    air.Q.value = 0.4;
    master = context.createGain();
    master.gain.value = 0.5;
    master.connect(air).connect(compressor).connect(context.destination);
    return context;
  }

  function chime(ctx: AudioContext, dest: AudioNode, freq: number, volume: number, attack: number, decay: number, now: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.988, now + attack + decay);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    osc.connect(gain).connect(dest);
    osc.start(now);
    osc.stop(now + attack + decay + 0.06);
  }

  function begin() {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    sparkleIndex = 0;
    chime(ctx, master, 783.99, 0.02, 0.018, 0.42, now);
    chime(ctx, master, 987.77, 0.024, 0.02, 0.5, now + 0.05);
    chime(ctx, master, 1174.66, 0.016, 0.022, 0.4, now + 0.1);
  }

  function tick(velocityDegPerSec: number) {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    if (now - lastTickAt < 0.038) return;
    lastTickAt = now;
    const speed = Math.min(1, Math.max(0, (Number.isFinite(velocityDegPerSec) ? velocityDegPerSec : 0) / 640));
    const freq = SPARKLE[sparkleIndex % SPARKLE.length];
    sparkleIndex += 1;
    const volume = 0.01 + (1 - speed) * 0.012;
    const decay = 0.16 + (1 - speed) * 0.1;
    chime(ctx, master, freq, volume, 0.014, decay, now);
    chime(ctx, master, freq * 2, volume * 0.12, 0.018, decay * 0.55, now);
  }

  function lock() {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    chime(ctx, master, 1318.51, 0.022, 0.022, 0.72, now);
    chime(ctx, master, 987.77, 0.028, 0.026, 0.95, now + 0.055);
    chime(ctx, master, 783.99, 0.024, 0.03, 1.15, now + 0.12);
    chime(ctx, master, 587.33, 0.014, 0.034, 0.9, now + 0.18);
  }

  function stop() {
    const current = context;
    context = null;
    master = null;
    air = null;
    lastTickAt = 0;
    sparkleIndex = 0;
    if (current && current.state !== "closed") void current.close().catch(() => undefined);
  }

  return { begin, tick, lock, stop };
}
