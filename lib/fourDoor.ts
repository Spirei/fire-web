/** 四色门转盘：缓动曲线与和转角联动的棘轮音效。 */

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

export function createFourDoorAudio() {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let air: BiquadFilterNode | null = null;
  let lastTickAt = 0;

  function ensure() {
    if (typeof window === "undefined") return null;
    if (context && context.state !== "closed") return context;
    const Ctor = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    if (context.state === "suspended") void context.resume();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 10;
    compressor.ratio.value = 1.8;
    compressor.attack.value = 0.012;
    compressor.release.value = 0.16;
    air = context.createBiquadFilter();
    air.type = "lowpass";
    air.frequency.value = 2400;
    air.Q.value = 0.55;
    master = context.createGain();
    master.gain.value = 0.58;
    master.connect(air).connect(compressor).connect(context.destination);
    return context;
  }

  function tone(ctx: AudioContext, dest: AudioNode, freq: number, volume: number, attack: number, decay: number, now: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    osc.connect(gain).connect(dest);
    osc.start(now);
    osc.stop(now + attack + decay + 0.04);
  }

  function tick(velocityDegPerSec: number) {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    if (now - lastTickAt < 0.028) return;
    lastTickAt = now;
    const speed = Math.min(1, Math.max(0, (Number.isFinite(velocityDegPerSec) ? velocityDegPerSec : 0) / 640));
    const dur = 0.034 + (1 - speed) * 0.028;
    const volume = 0.012 + (1 - speed) * 0.018;
    const ping = 620 - speed * 80;
    tone(ctx, master, ping, volume, 0.01, dur, now);
    tone(ctx, master, ping * 1.5, volume * 0.22, 0.012, dur * 0.7, now);
  }

  function lock() {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    tone(ctx, master, 783.99, 0.048, 0.02, 0.62, now);
    tone(ctx, master, 1174.66, 0.026, 0.024, 0.5, now);
    tone(ctx, master, 1567.98, 0.01, 0.028, 0.36, now);
  }

  function stop() {
    const current = context;
    context = null;
    master = null;
    air = null;
    lastTickAt = 0;
    if (current && current.state !== "closed") void current.close().catch(() => undefined);
  }

  return { tick, lock, stop };
}
