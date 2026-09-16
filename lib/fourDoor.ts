/** 四色门转盘：缓动曲线，以及对照花园那场原片转盘的三段风铃碎晶（合成，不取样原片）。 */

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

/** 花园那场转盘碎晶：C7–C#8 一带，带一个低八度身。 */
const TREE = [2093.0, 2349.3, 2637.0, 3136.0, 3520.0, 3951.1, 4186.0, 4434.9];
const SPIN = [2349.3, 2637.0, 2793.8, 3136.0, 3520.0];

export function createFourDoorAudio() {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let air: BiquadFilterNode | null = null;
  let lastTickAt = 0;
  let spinIndex = 0;

  function ensure() {
    if (typeof window === "undefined") return null;
    if (context && context.state !== "closed") return context;
    const Ctor = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    if (context.state === "suspended") void context.resume();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -26;
    compressor.knee.value = 14;
    compressor.ratio.value = 1.6;
    compressor.attack.value = 0.018;
    compressor.release.value = 0.28;
    air = context.createBiquadFilter();
    air.type = "lowpass";
    air.frequency.value = 5400;
    air.Q.value = 0.32;
    master = context.createGain();
    master.gain.value = 0.46;
    master.connect(air).connect(compressor).connect(context.destination);
    return context;
  }

  function tone(ctx: AudioContext, dest: AudioNode, freq: number, volume: number, attack: number, decay: number, now: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.994, now + attack + decay);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    osc.connect(gain).connect(dest);
    osc.start(now);
    osc.stop(now + attack + decay + 0.05);
  }

  /** 一根风铃：基音 + 微失谐（金属感）+ 低八度身，避免单音电子哔。 */
  function bar(ctx: AudioContext, dest: AudioNode, freq: number, volume: number, attack: number, decay: number, now: number) {
    tone(ctx, dest, freq, volume, attack, decay, now);
    tone(ctx, dest, freq * 1.016, volume * 0.42, attack + 0.004, decay * 0.78, now);
    tone(ctx, dest, freq * 0.5, volume * 0.28, attack + 0.006, decay * 1.15, now);
  }

  function begin() {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    bar(ctx, master, 2093.0, 0.01, 0.016, 0.55, now);
    for (let i = 0; i < 5; i += 1) {
      const freq = TREE[4 + (i % 4)] * (0.997 + ((i * 13) % 5) * 0.0018);
      bar(ctx, master, freq, 0.011 * (1 - i * 0.08), 0.014, 0.36 - i * 0.02, now + 0.012 + i * 0.038);
    }
  }

  function tick(velocityDegPerSec: number) {
    const ctx = ensure();
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    if (now - lastTickAt < 0.042) return;
    lastTickAt = now;
    const speed = Math.min(1, Math.max(0, (Number.isFinite(velocityDegPerSec) ? velocityDegPerSec : 0) / 640));
    const freq = SPIN[spinIndex % SPIN.length] * (0.996 + ((spinIndex * 11) % 5) * 0.002);
    spinIndex += 1;
    bar(ctx, master, freq, 0.0055 + (1 - speed) * 0.0045, 0.012, 0.18 + (1 - speed) * 0.1, now);
    if (speed < 0.45) {
      bar(ctx, master, SPIN[spinIndex % SPIN.length], 0.004, 0.014, 0.22, now + 0.028);
      spinIndex += 1;
    }
  }

  function lock() {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    bar(ctx, master, 1568.0, 0.012, 0.022, 0.82, now);
    bar(ctx, master, 2093.0, 0.011, 0.02, 0.7, now + 0.036);
    const down = [4434.9, 4186.0, 3951.1, 3520.0, 3136.0, 2637.0];
    for (let i = 0; i < down.length; i += 1) {
      bar(ctx, master, down[i], 0.009 * (1 - i * 0.08), 0.016, 0.48 + i * 0.04, now + 0.02 + i * 0.036);
    }
  }

  function stop() {
    const current = context;
    context = null;
    master = null;
    air = null;
    lastTickAt = 0;
    spinIndex = 0;
    if (current && current.state !== "closed") void current.close().catch(() => undefined);
  }

  return { begin, tick, lock, stop };
}
