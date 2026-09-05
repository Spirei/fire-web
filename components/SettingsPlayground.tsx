"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePersistedState } from "@/lib/usePersistedState";

const heroes = [
  { name: "马里奥", color: "#ec4035", kind: "cap" },
  { name: "路易吉", color: "#43ad47", kind: "cap" },
  { name: "碧姬", color: "#ee78af", kind: "princess" },
  { name: "耀西", color: "#67bc42", kind: "dino" },
  { name: "奇诺比奥", color: "#ef5449", kind: "mushroom" },
  { name: "奇诺比珂", color: "#ed73b0", kind: "mushroom" },
] as const;

// Compact vector sprites stay sharp at every display scale and require no remote assets.
function PixelHero({ index }: { index: number }) {
  const hero = heroes[index] || heroes[0];
  return <svg viewBox="-1 -1 26 32" aria-hidden="true" shapeRendering="crispEdges">
    {hero.kind === "cap" && <>
      <path fill="#493323" d="M5 1h13v3h4v5h-3v1h4v6h-5v1h3v3h3v4h-4v3h2v4h-9v-4h-2v4H0v-4h4v-3H0v-7h3v-2H4V8H2V4h3z" />
      <path fill={hero.color} d="M6 2h11v3h4v3H3V5h3zM4 16h15v8H4z" />
      <path fill="#ffcf94" d="M6 8h12v3h4v4h-5v3H6zM1 18h4v5H1zM19 18h4v5h-4z" />
      <path fill="#613a26" d="M5 8h5v3H8v5H5zM14 12h3v2h4v3h-8v-3h1zM4 27h7v3H1v-3zM14 27h7v3h-7z" />
      <path fill="#2861c8" d="M7 17h3v5h5v-5h3v10h-7v-3H9v3H5v-5h2z" />
      <path fill="#fbfbec" d="M1 19h4v4H1zM19 19h4v4h-4zM11 3h5v4h-5z" />
      <path fill={hero.color} d={index === 1 ? "M12 4h1v2h2v1h-3z" : "M12 4h1v1h1V4h1v3h-1V6h-1v1h-1z"} />
      <path fill="#ffffff" opacity=".35" d="M6 3h4v1H6zM4 5h6v1H4z" />
      <path fill="#ba7652" d="M7 14h3v2H7z" /><path fill="#fff0c3" d="M18 11h3v2h-3z" />
      <path fill="#4b8aeb" d="M7 23h3v3H7zM15 23h2v3h-2z" />
      <path fill="#a17646" d="M3 27h6v1H3zM15 27h5v1h-5z" />
      <path fill="#ffd556" d="M8 21h2v2H8zM15 21h2v2h-2z" /><path fill="#252c36" d="M15 8h2v4h-2z" />
    </>}
    {hero.kind === "princess" && <>
      <path fill="#9b622d" d="M6 0h11v4h2v3h1v10h3v7h1v6H1v-6H0v-7h3V8h2V4h1z" />
      <path fill="#f7cc4f" d="M6 5h12v16H4V9h2zM7 0h3v3h3V0h3v6H7z" />
      <path fill="#ffdab7" d="M9 7h8v10H9zM2 18h4v6H2zM19 18h4v6h-4z" />
      <path fill={hero.color} d="M8 16h10v5h2v4h3v4H2v-4h3v-4h3z" />
      <path fill="#ffbade" d="M9 19h7v5h3v3H6v-3h3z" /><path fill="#2c6ea0" d="M14 9h2v3h-2zM11 17h3v3h-3z" />
      <path fill="#fff8ed" d="M2 19h4v5H2zM19 19h4v5h-4zM11 17h1v1h-1zM14 9h1v1h-1z" />
      <path fill="#ffe787" d="M6 7h2v11H6zM4 17h2v3H4z" />
      <path fill="#ef516c" d="M10 3h2v2h-2zM13 14h2v1h-2z" />
      <path fill="#ce4d89" d="M4 25h3v2h11v-2h3v3H4z" />
    </>}
    {hero.kind === "dino" && <>
      <path fill="#2d5729" d="M8 1h11v4h5v11h-7v2h2v6h2v2h3v5H2v-4h2v-3H0v-9h4v3h3v-8H5V4h3z" />
      <path fill={hero.color} d="M9 2h9v4h5v9h-9v4h4v6H5v-3H1v-6h3v3h4V9H6V5h3z" />
      <path fill="#fff9db" d="M10 4h7v6h-7zM11 15h5v9h-6z" /><path fill="#253c32" d="M13 5h2v4h-2z" />
      <path fill="#b3ef7c" d="M10 2h7v1h-7zM17 7h5v2h-5z" />
      <path fill="#fff9e9" d="M8 5h3v5H8zM14 14h7v2h-7z" /><path fill="#253c32" d="M9 6h1v3H9zM21 11h1v1h-1z" />
      <path fill="#ee5441" d="M5 12h4v7H5z" /><path fill="#eaa631" d="M5 25h7v4H3v-2h2zM15 24h5v3h3v3h-8z" />
    </>}
    {hero.kind === "mushroom" && <>
      <path fill="#63423a" d="M5 0h14v3h4v4h2v9h-5v4h3v7h1v4H2v-4H1v-9h4v-2H-1V7h2V3h4z" />
      <path fill="#fff4df" d="M6 1h12v3h4v4h2v7H0V8h2V4h4z" />
      <path fill={hero.color} d="M9 2h7v8H9zM1 8h4v6H1zM19 6h4v7h-4zM5 20h4v6H4v-4H2v-3h3zM16 20h4v6h-4z" />
      <path fill="#ffcf94" d="M6 15h13v6H6zM9 22h7v5H9z" /><path fill="#342d2b" d="M9 16h2v3H9zM15 16h2v3h-2z" />
      <path fill="#744429" d="M4 27h8v3H3v-2h1zM15 27h7v3h-7z" />
      <path fill="#fffefa" d="M6 4h2v5H6zM17 5h2v4h-2z" />
      <path fill="#f4b887" d="M7 20h11v1H7z" /><path fill="#5b3230" d="M12 19h3v1h-3z" />
      {index === 4 ? <><path fill="#2966d1" d="M5 21h3v5H5zM17 21h3v5h-3z" /><path fill="#ffd457" d="M7 21h1v5H7zM16 21h1v5h-1z" /></> : <>
        <path fill="#cf438d" d="M0 15h4v5H0zM-1 21h5v5h-5zM20 15h4v5h-4zM21 21h4v5h-4zM8 23h9v4H8z" />
        <path fill="#ffecfc" d="M0 22h2v2H0zM22 22h2v2h-2zM9 26h8v1H9z" />
      </>}
    </>}
  </svg>;
}

const rewards = ["金币 +1", "超级蘑菇 · 长大啦", "幸运星 · 闪耀时刻", "金币 +5", "火焰花 · 火力全开"];
export default function SettingsPlayground() {
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [savedHero, setHero] = usePersistedState("fire:playground-hero", 0);
  const selected = Number.isInteger(savedHero) && savedHero >= 0 && savedHero < heroes.length ? savedHero : 0;
  const [underground, setUnderground] = useState(false);
  const [reward, setReward] = useState(-1);
  const [coins, setCoins] = useState(0);
  const [message, setMessage] = useState("点击场景，开始键盘冒险");
  const [power, setPower] = useState("");
  const [piping, setPiping] = useState(false);
  const [hit, setHit] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const actor = useRef<HTMLButtonElement>(null);
  const model = useRef({ x: 80, y: 0, vy: 0, facing: 1, piping: false });
  const keys = useRef(new Set<string>());
  const wake = useRef(() => {});
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const rewardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function later(fn: () => void, ms: number) { const id = setTimeout(() => { timers.current.delete(id); fn(); }, ms); timers.current.add(id); return id; }
  const collect = useRef(() => {});
  collect.current = () => {
    const next = Math.floor(Math.random() * rewards.length);
    setReward(next); setMessage(rewards[next]); setHit(true);
    if (next === 0 || next === 3) setCoins(c => c + (next === 3 ? 5 : 1));
    setPower(next === 1 ? "big" : next === 2 ? "star" : next === 4 ? "fire" : "");
    if (rewardTimer.current) { clearTimeout(rewardTimer.current); timers.current.delete(rewardTimer.current); }
    rewardTimer.current = later(() => setReward(-1), 1100);
    later(() => setHit(false), 240);
  };
  useEffect(() => {
    let frame: number | null = null;
    let last = 0;
    const render = () => {
      const m = model.current;
      if (!actor.current) return;
      actor.current.style.transform = `translate3d(${Math.round(m.x - (actor.current.offsetWidth / 2))}px, ${-Math.round(m.y)}px, 0)`;
      actor.current.style.setProperty("--sp-facing", String(m.facing));
      actor.current.dataset.moving = String(keys.current.size > 0 && m.y === 0);
      actor.current.dataset.airborne = String(m.y > 0);
    };
    const step = (time: number) => {
      frame = null;
      const dt = Math.max(1 / 240, Math.min((time - last) / 1000, 0.032)); last = time;
      const m = model.current;
      if (m.piping) return;
      const width = stage.current?.clientWidth || 160;
      const direction = Number(keys.current.has("ArrowRight")) - Number(keys.current.has("ArrowLeft"));
      if (direction) { m.x += direction * 95 * dt; m.facing = direction; }
      m.x = Math.max(17, Math.min(width - 18, m.x));
      const previousY = m.y;
      if (m.y > 0 || m.vy > 0) { m.vy -= 1100 * dt; m.y = Math.max(0, m.y + m.vy * dt); }
      const block = stage.current?.querySelector<HTMLElement>(".sp-question");
      const wall = stage.current?.querySelector<HTMLElement>(".sp-wall");
      const ceiling = (stage.current?.clientHeight || 152) - 9 - (actor.current?.offsetHeight || 40) - (wall?.offsetTop || 30) - (block?.offsetHeight || 25);
      if (m.vy > 0 && previousY < ceiling && m.y >= ceiling && Math.abs(m.x - width / 2) < (wall?.offsetWidth || 133) / 2 + 10) {
        m.y = ceiling; m.vy = -35;
        if (Math.abs(m.x - width / 2) < (block?.offsetWidth || 25) / 2 + 7) collect.current();
        else setMessage("砖墙很结实，试试中间的问号");
      }
      if (m.y === 0) m.vy = 0;
      render();
      if (keys.current.size || m.y > 0) frame = requestAnimationFrame(step);
    };
    wake.current = () => { if (frame === null) { last = performance.now(); frame = requestAnimationFrame(step); } };
    model.current = { x: (stage.current?.clientWidth || 160) / 2, y: 0, vy: 0, facing: 1, piping: false };
    setPiping(false); setHit(false); setReward(-1);
    if (expanded) stage.current?.focus({ preventScroll: true });
    render();
    const stop = () => { keys.current.clear(); wake.current(); };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      timers.current.forEach(clearTimeout); timers.current.clear();
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", stop);
      wake.current = () => {};
    };
  }, [expanded]);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [expanded]);
  function close() { setExpanded(false); requestAnimationFrame(() => expandButton.current?.focus({ preventScroll: true })); }
  function jump() {
    const m = model.current;
    if (m.piping || m.y > 0) return;
    m.vy = 360; wake.current();
  }
  function pipe() {
    const m = model.current;
    if (m.piping || m.y > 0) return;
    stage.current?.focus({ preventScroll: true });
    keys.current.clear(); m.piping = true;
    actor.current?.style.setProperty("--sp-pipe-from", `${m.x - (actor.current?.offsetWidth || 32) / 2}px`);
    setPiping(true); setPower(""); setReward(-1);
    later(() => { setUnderground(v => !v); setMessage(underground ? "回到地面，继续冒险" : "地下世界！问号砖还有惊喜"); }, 600);
    later(() => { m.piping = false; m.x = (stage.current?.clientWidth || 160) - 52; setPiping(false); wake.current(); }, 1200);
  }
  const scene = <section className={`settings-playground ${expanded ? "sp-expanded" : "sp-compact"} ${underground ? "is-underground" : ""}`} aria-label="蘑菇王国互动彩蛋"
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { keys.current.clear(); wake.current(); } }}>
    {expanded && <div className="sp-dialog-heading"><strong>蘑菇王国</strong><button type="button" onClick={close} aria-label="收起游戏">×</button></div>}
    <div className="sp-hud"><span>{underground ? "WORLD 1-2" : "WORLD 1-1"}</span><span className="sp-score"><i /> × {String(coins).padStart(2, "0")}</span></div>
    <div ref={stage} className="sp-stage" tabIndex={0} role="group" aria-label="游戏场景，左右键移动，上键或空格跳跃，下键进入管道" aria-describedby="sp-instructions"
      onPointerDown={() => stage.current?.focus({ preventScroll: true })}
      onKeyDown={e => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key)) return;
        e.preventDefault();
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") { if (!e.repeat && !model.current.piping) { const direction = e.key === "ArrowRight" ? 1 : -1; model.current.x += direction * 4; model.current.facing = direction; } keys.current.add(e.key); wake.current(); }
        else if (!e.repeat && (e.key === "ArrowUp" || e.key === " ")) jump();
        else if (!e.repeat && e.key === "ArrowDown") {
          if (model.current.x >= (stage.current?.clientWidth || 160) - 55) pipe();
          else setMessage("向右走到管道旁，再按 ↓");
        }
      }}
      onKeyUp={e => { keys.current.delete(e.key); wake.current(); }}>
      {expanded && <div className="sp-scenery" aria-hidden="true"><i /><i /><i /></div>}
      <span className="sp-cloud sp-cloud-one" /><span className="sp-cloud sp-cloud-two" />
      <div className="sp-wall"><span className="sp-brick" /><span className="sp-brick" />
        <button type="button" className={`sp-question ${hit ? "is-hit" : ""}`} onClick={() => { if (model.current.piping || model.current.y > 0) return; model.current.x = (stage.current?.clientWidth || 160) / 2; jump(); }} disabled={piping} aria-label="顶问号砖，随机获得道具" title="顶一下问号砖"><span>?</span></button>
        <span className="sp-brick" /><span className="sp-brick" />
      </div>
      {reward >= 0 && <span key={`${coins}-${reward}`} className={`sp-reward sp-reward-${reward}`} aria-hidden="true">{reward === 0 || reward === 3 ? <i className="sp-coin" /> : reward === 2 ? "★" : reward === 1 ? <i className="sp-mushroom" /> : <i className="sp-flower" />}</span>}
      <button ref={actor} type="button" className={`sp-hero ${piping ? "sp-enter-pipe" : ""} sp-power-${power}`} onClick={jump} disabled={piping} aria-label={`${heroes[selected].name}，点击跳跃`}><span className="sp-sprite"><PixelHero index={selected} /></span></button>
      <button type="button" className="sp-pipe" onClick={pipe} disabled={piping} aria-label={underground ? "钻管道返回地面" : "钻管道进入地下"} title={underground ? "返回地面" : "钻进管道"}><span /><b>↓</b></button>
      <div className="sp-ground" />
    </div>
    <p className={`sp-message ${expanded ? "" : "sr-only"}`} role="status" aria-live="polite">{message}</p>
    <p id="sp-instructions" className={`sp-instructions ${expanded ? "" : "sr-only"}`}><span>← → 移动</span><span>↑ / 空格 跳</span><span>↓ 管道</span></p>
    {expanded ? <div className="sp-heroes" aria-label="选择角色">{heroes.map((hero, index) => <button type="button" key={hero.name} aria-label={`选择${hero.name}`} aria-pressed={selected === index} title={hero.name} onClick={() => { setHero(index); setMessage(`${hero.name}，出发！`); stage.current?.focus({ preventScroll: true }); }} disabled={piping}><PixelHero index={index} /><span>{hero.name}</span></button>)}</div> : <button ref={expandButton} type="button" className="sp-expand" disabled={piping} onClick={() => setExpanded(true)} aria-label="展开游戏，切换角色和查看键盘操作"><span>{heroes[selected].name}</span><span>展开 ↗</span></button>}
  </section>;
  return <>
    <div className="sp-sidebar-slot">{expanded ? <button type="button" className="sp-return" onClick={close}><PixelHero index={selected} /><span>游戏已展开 · 收起</span></button> : scene}</div>
    {expanded && createPortal(<div className="sp-overlay" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="sp-dialog" role="dialog" aria-modal="true" aria-label="蘑菇王国游戏" onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); close(); }
        if (e.key === "Tab") {
          const focusable = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'));
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>{scene}</div>
    </div>, document.body)}
  </>;
}
