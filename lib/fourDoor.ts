/** 四色门转盘：缓动曲线，以及开始 / 转动 / 落定的纸牌拨动感音效（合成，不取样原片）。 */

export const TICK_DEG = 15;
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
  let noise: AudioBuffer | null = null;
  let lastTickAt = 0;

  function ensure() {
    if (typeof window === "undefined") return null;
    if (context && context.state !== "closed") return context;
    const Ctor = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    if (context.state === "suspended") void context.resume();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -22;
    compressor.knee.value = 8;
    compressor.ratio.value = 1.7;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.14;
    air = context.createBiquadFilter();
    air.type = "lowpass";
    air.frequency.value = 2800;
    air.Q.value = 0.5;
    master = context.createGain();
    master.gain.value = 0.62;
    master.connect(air).connect(compressor).connect(context.destination);
    const samples = Math.floor(context.sampleRate * 0.2);
    noise = context.createBuffer(1, samples, context.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < samples; i += 1) data[i] = Math.random() * 2 - 1;
    return context;
  }

  function flick(ctx: AudioContext, dest: AudioNode, now: number, volume: number, bright: number, decay: number) {
    if (!noise) return;
    const source = ctx.createBufferSource();
    const band = ctx.createBiquadFilter();
    const high = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = noise;
    band.type = "bandpass";
    band.frequency.value = 900 + bright * 700;
    band.Q.value = 1.1;
    high.type = "highpass";
    high.frequency.value = 280;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    source.connect(high).connect(band).connect(gain).connect(dest);
    source.start(now);
    source.stop(now + decay + 0.02);
  }

  function wood(ctx: AudioContext, dest: AudioNode, now: number, freq: number, volume: number, decay: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.72, now + decay);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    osc.connect(gain).connect(dest);
    osc.start(now);
    osc.stop(now + decay + 0.03);
  }

  function begin() {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    flick(ctx, master, now, 0.055, 0.35, 0.07);
    wood(ctx, master, now, 210, 0.03, 0.09);
    flick(ctx, master, now + 0.045, 0.04, 0.55, 0.055);
  }

  function tick(velocityDegPerSec: number) {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    if (now - lastTickAt < 0.02) return;
    lastTickAt = now;
    const speed = Math.min(1, Math.max(0, (Number.isFinite(velocityDegPerSec) ? velocityDegPerSec : 0) / 640));
    const volume = 0.018 + (1 - speed) * 0.016;
    flick(ctx, master, now, volume, 0.25 + speed * 0.5, 0.028 + (1 - speed) * 0.02);
    if (speed < 0.45) wood(ctx, master, now, 180 + speed * 40, 0.012, 0.04);
  }

  function lock() {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    flick(ctx, master, now, 0.05, 0.4, 0.06);
    wood(ctx, master, now, 245, 0.038, 0.11);
    wood(ctx, master, now + 0.03, 390, 0.016, 0.08);
  }

  function stop() {
    const current = context;
    context = null;
    master = null;
    air = null;
    noise = null;
    lastTickAt = 0;
    if (current && current.state !== "closed") void current.close().catch(() => undefined);
  }

  return { begin, tick, lock, stop };
}
