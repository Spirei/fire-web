/** 四色门转盘：缓动曲线与和转角联动的棘轮音效。 */

export const TICK_DEG = 15;
export const SHORT_TURN_MS = 680;
export const LONG_TURN_MS = 1680;

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

export const easeShort = cubicBezier(0.18, 0.78, 0.18, 1);
export const easeLong = cubicBezier(0.08, 0.86, 0.12, 1);

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

export function createFourDoorAudio() {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;

  function ensure() {
    if (typeof window === "undefined") return null;
    if (context && context.state !== "closed") return context;
    const Ctor = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 6;
    compressor.ratio.value = 2.8;
    compressor.attack.value = 0.001;
    compressor.release.value = 0.09;
    master = context.createGain();
    master.gain.value = 0.9;
    master.connect(compressor).connect(context.destination);
    const samples = Math.floor(context.sampleRate * 0.08);
    noise = context.createBuffer(1, samples, context.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < samples; i += 1) data[i] = Math.random() * 2 - 1;
    return context;
  }

  function tick(velocityDegPerSec: number) {
    const ctx = ensure();
    if (!ctx || !master || !noise) return;
    const speed = Math.min(1, Math.max(0, velocityDegPerSec / 780));
    const now = ctx.currentTime;
    const dur = 0.016 + (1 - speed) * 0.028;
    const volume = 0.034 + (1 - speed) * 0.05;
    const ping = 860 + speed * 640;

    const source = ctx.createBufferSource();
    const noiseFilter = ctx.createBiquadFilter();
    const noiseGain = ctx.createGain();
    source.buffer = noise;
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 1400 + speed * 1800;
    noiseFilter.Q.value = 1.6;
    noiseGain.gain.setValueAtTime(0.0001, now);
    noiseGain.gain.exponentialRampToValueAtTime(volume * 1.15, now + 0.0012);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    source.connect(noiseFilter).connect(noiseGain).connect(master);
    source.start(now);
    source.stop(now + dur + 0.01);

    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(ping, now);
    osc.frequency.exponentialRampToValueAtTime(ping * 0.62, now + dur);
    oscGain.gain.setValueAtTime(0.0001, now);
    oscGain.gain.exponentialRampToValueAtTime(volume * 0.7, now + 0.001);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(oscGain).connect(master);
    osc.start(now);
    osc.stop(now + dur + 0.008);
  }

  function lock() {
    const ctx = ensure();
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    const thud = ctx.createOscillator();
    const thudGain = ctx.createGain();
    thud.type = "sine";
    thud.frequency.setValueAtTime(168, now);
    thud.frequency.exponentialRampToValueAtTime(92, now + 0.16);
    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.exponentialRampToValueAtTime(0.12, now + 0.004);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    thud.connect(thudGain).connect(master);
    thud.start(now);
    thud.stop(now + 0.2);

    ([
      [1318.5, 0.07, 0.22],
      [1975.5, 0.035, 0.16],
      [2637, 0.016, 0.1]
    ] as const).forEach(([freq, volume, duration]) => {
      const bell = ctx.createOscillator();
      const gain = ctx.createGain();
      bell.type = "sine";
      bell.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume, now + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      bell.connect(gain).connect(master!);
      bell.start(now);
      bell.stop(now + duration + 0.01);
    });
  }

  function stop() {
    const current = context;
    context = null;
    master = null;
    noise = null;
    if (current && current.state !== "closed") void current.close().catch(() => undefined);
  }

  return { tick, lock, stop };
}
