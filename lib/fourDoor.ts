/** 四色门转盘：缓动曲线，音效以线上版棘轮为基线（合成，不取样原片）。 */

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
  let lastTickAt = 0;
  let tickIndex = 0;
  let click: AudioBuffer | null = null;

  function ensure() {
    if (typeof window === "undefined") return null;
    if (context && context.state !== "closed") return context;
    const Ctor = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    if (context.state === "suspended") void context.resume();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 5;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.001;
    compressor.release.value = 0.08;
    master = context.createGain();
    master.gain.value = 0.88;
    master.connect(compressor).connect(context.destination);
    const n = Math.floor(context.sampleRate * 0.014);
    click = context.createBuffer(1, n, context.sampleRate);
    const data = click.getChannelData(0);
    for (let i = 0; i < n; i += 1) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 6);
    return context;
  }

  /** 线上版滑动棘轮：三角波 690→410，高通 360Hz，约 45ms。 */
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

  function begin() {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    tickIndex = 0;
    lastTickAt = ctx.currentTime;
    ratchet(ctx, master, 0, 0.055, ctx.currentTime + 0.1);
    tickIndex = 1;
  }

  function tick(velocityDegPerSec: number) {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    if (now - lastTickAt < 0.09) return;
    lastTickAt = now;
    const speed = Math.min(1, Math.max(0, (Number.isFinite(velocityDegPerSec) ? velocityDegPerSec : 0) / 640));
    ratchet(ctx, master, tickIndex, 0.04 + (1 - speed) * 0.018, now);
    tickIndex += 1;
  }

  function lock() {
    const ctx = ensure();
    if (!ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    ([
      [1567.98, 0.18, 0.22],
      [3135.96, 0.09, 0.14],
      [4703.94, 0.04, 0.1]
    ] as const).forEach(([frequency, volume, duration]) => {
      const bell = ctx.createOscillator();
      const gain = ctx.createGain();
      bell.type = "sine";
      bell.frequency.setValueAtTime(frequency, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume, now + 0.0015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      bell.connect(gain).connect(master!);
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
    gain.gain.setValueAtTime(0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.014);
    transient.connect(filter).connect(gain).connect(master);
    transient.start(now);
  }

  function stop() {
    const current = context;
    context = null;
    master = null;
    click = null;
    lastTickAt = 0;
    tickIndex = 0;
    if (current && current.state !== "closed") void current.close().catch(() => undefined);
  }

  return { begin, tick, lock, stop };
}
