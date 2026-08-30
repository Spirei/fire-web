"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import { CELEBS, type Celeb, type CelebHolding } from "@/lib/celebs";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { showToast } from "@/lib/toast";
import CelebsManageModal from "@/components/CelebsManageModal";

const UP = "text-up";
const DOWN = "text-down";

/* 美股公司图标兜底（与全球预览 / 财报日历同一来源，素材库优先） */
const US_LOGO_BASE = "https://g.foolcdn.com/art/companylogos/square/";

function CelebLogo({
  code,
  name,
  size = 26,
  ring = false,
  overrideSrc,
  market
}: {
  code: string;
  name: string;
  size?: number;
  ring?: boolean;
  overrideSrc?: string;
  market?: string;
}) {
  const { stockIcons, cdnEnabled } = useAssetIcons();
  const key = code.toUpperCase();
  const src = stockIcons[`${market || "US"}:${key}`] || stockIcons[`US:${key}`];
  const [err, setErr] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const remote = `${US_LOGO_BASE}${code.toUpperCase()}.png`;
  // 全部走素材库：本地有图标优先；CDN 通道关闭时素材库没有的股票不请求外部图标（显示首字母）
  const url = overrideSrc || src || (cdnEnabled ? remote : "");
  const isRemote = cdnEnabled && !overrideSrc && !src;
  // 外部兜底图标：失败 / 超时后记入 sessionStorage，本次会话刷新不再重复请求慢 CDN（如 foolcdn）
  const failKey = `fire:logo-fail:${key}`;
  const [cachedFail] = useState(() => {
    if (!isRemote) return false;
    try {
      return sessionStorage.getItem(failKey) === "1";
    } catch {
      return false;
    }
  });
  const showImg = !!url && !err && !timedOut && !cachedFail;

  useEffect(() => {
    if (!showImg || !isRemote) return;
    // 1.5s 未加载完成即降级为占位并记忆，避免外部图片长时间阻塞页面
    const t = window.setTimeout(() => {
      setTimedOut(true);
      try {
        sessionStorage.setItem(failKey, "1");
      } catch {
        /* 忽略 */
      }
    }, 1500);
    return () => window.clearTimeout(t);
  }, [showImg, isRemote, failKey]);

  if (showImg) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        onLoad={() => {
          try {
            sessionStorage.removeItem(failKey);
          } catch {
            /* 忽略 */
          }
        }}
        onError={() => {
          setErr(true);
          try {
            sessionStorage.setItem(failKey, "1");
          } catch {
            /* 忽略 */
          }
        }}
        style={{ width: size, height: size }}
        className={`flex-none object-cover ${ring ? "rounded-full bg-white" : "rounded-full ring-1 ring-black/10 dark:ring-white/15"}`}
      />
    );
  }
  return (
    <span
      className={`flex flex-none items-center justify-center font-bold ${
        ring
          ? "rounded-full bg-white text-brand-deep shadow-sm ring-1 ring-black/5"
          : "rounded-full bg-brand-light text-brand-deep dark:bg-white/10 dark:text-white"
      }`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {name.slice(0, 1)}
    </span>
  );
}

function SourceBadge({ celeb, detail }: { celeb: Celeb; detail?: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    sec13f: { cls: "bg-bg-gray text-muted dark:bg-white/5 dark:text-[#aab2c0]", label: "SEC 13F" },
    secform4: { cls: "bg-bg-gray text-muted dark:bg-white/5 dark:text-[#aab2c0]", label: "SEC Form 4" },
    sample: { cls: "bg-bg-gray text-muted dark:bg-white/5 dark:text-[#aab2c0]", label: "示例数据" }
  };
  const m = map[celeb.dataSource] ?? map.sample;
  // 主文字优先显示名人管理里配置的「来源标签」，缺失时才用类型标签
  const label = detail || m.label;
  const fallback = celeb.dataSource === "sample" && !label.includes("示例") ? " · 当前为示例兜底数据（SEC 暂不可达）" : "";
  return (
    <span title={`${label}${fallback}`} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${m.cls}`}>
      <span className="h-1 w-1 rounded-full bg-current opacity-70" />
      {label}
    </span>
  );
}

/* 新版圆环图：蓝色系分段环（前 5 大持仓 + 其他聚合）+ 悬停扇区弹出 + 公司 Logo 落环 + 头像居中 */
/* 参考富途「聪明钱」：无间隙扇形弧（锐边），
   颜色亮度与扇区大小成正比（最大段亮蓝 → 小段深藏青，按名次插值），
   最大持仓段最亮并向外突出，股票 Logo 落在扇区角度中央、略偏外圈，中心头像 */
const RING_BRIGHT: [number, number, number] = [43, 93, 227]; // #2B5DE3
const RING_DARK: [number, number, number] = [14, 29, 71]; // #0E1D47
const RING_BASE = "rgb(14, 29, 71)";
const AVATAR_CACHE_KEY = "fire:celebs-avatars";
const CELEBS_CACHE_KEY = "fire:celebs:data";

function loadAvatarCache(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(AVATAR_CACHE_KEY) || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function saveAvatarCache(map: Record<string, string>) {
  try {
    localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify(map));
  } catch {
    /* 忽略存储失败 */
  }
}

function loadCelebsCache(): { celebs?: Celeb[]; detail?: Record<string, string>; source?: string } {
  try {
    return JSON.parse(localStorage.getItem(CELEBS_CACHE_KEY) || "{}") as {
      celebs?: Celeb[];
      detail?: Record<string, string>;
      source?: string;
    };
  } catch {
    return {};
  }
}

function saveCelebsCache(data: { celebs: Celeb[]; detail: Record<string, string>; source: string }) {
  try {
    localStorage.setItem(CELEBS_CACHE_KEY, JSON.stringify({ ...data, at: Date.now() }));
  } catch {
    /* 忽略存储失败 */
  }
}

/* 旧缓存没有对比基准指数时兜底：spxPoints → 标普500 */
function withBenchmarkFallback(c: Celeb): Celeb {
  const ret = c.returns;
  if (!ret) return c;
  const benches =
    Array.isArray(ret.benchmarks) && ret.benchmarks.length > 0
      ? ret.benchmarks
      : Array.isArray(ret.spxPoints) && ret.spxPoints.length > 1
        ? [{ code: "SPX", name: "标普500指数", y1: ret.spxY1 ?? 0, points: ret.spxPoints }]
        : [];
  return { ...c, returns: { ...ret, benchmarks: benches } };
}

function ringShade(i: number, n: number): string {
  const t = n <= 1 ? 0 : i / (n - 1);
  const c = RING_BRIGHT.map((v, k) => Math.round(v + (RING_DARK[k] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function CelebRing({ celeb, size = 138 }: { celeb: Celeb; size?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [avatarHover, setAvatarHover] = useState(false);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const [avatarTransparent, setAvatarTransparent] = useState(false);

  // 头像 URL 变化（如刷新后拉到最新自定义头像）时重置加载失败状态
  useEffect(() => {
    setAvatarBroken(false);
  }, [celeb.avatar]);

  // 检测头像是否为透明 PNG：透明图用自由轮廓（不圆形硬切，保留肩膀/衣领），非透明图保持圆形裁剪
  useEffect(() => {
    if (!celeb.avatar) {
      setAvatarTransparent(false);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let hasAlpha = false;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 250) {
            hasAlpha = true;
            break;
          }
        }
        if (!cancelled) setAvatarTransparent(hasAlpha);
      } catch {
        if (!cancelled) setAvatarTransparent(false);
      }
    };
    img.onerror = () => {
      if (!cancelled) setAvatarTransparent(false);
    };
    img.src = celeb.avatar;
    return () => {
      cancelled = true;
    };
  }, [celeb.avatar]);
  const top = celeb.holdings.slice(0, 5);
  const rest = celeb.holdings.slice(5);
  const restWeight = rest.reduce((s, h) => s + h.weight, 0);
  const weights =
    rest.length > 0
      ? [
          ...top.map((h) => ({ ...h })),
          { code: "OTHER", name: "其他持仓", market: "US", weight: restWeight, price: 0, changePct: 0, target: 0 } as CelebHolding
        ]
      : top.map((h) => ({ ...h }));
  const total = weights.reduce((s, h) => s + h.weight, 0) || 1;

  const R = 50;
  const rOuter = R - 2; // 外半径
  const rInner = R - 21; // 内半径（环宽约 19/50 ≈ 38%，接近参考的粗环）
  const POP = 2.4; // 悬停向外弹出距离（viewBox 单位）
  let acc = 0;
  const segs = weights.map((h, i) => {
    const frac = h.weight / total;
    const start = acc;
    acc += frac;
    return { h, i, frac, start, end: start + frac };
  });
  // 最大持仓段：最亮 + 向外突出（外扩 2 / 内收 2，参考图最大扇区明显凸出）
  const maxIdx = segs.reduce((mi, s, i) => (s.frac > segs[mi].frac ? i : mi), 0);

  const angle = (t: number) => t * 2 * Math.PI - Math.PI / 2; // 从 12 点方向顺时针
  const pt = (t: number, rad: number) => ({
    x: R + rad * Math.cos(angle(t)),
    y: R + rad * Math.sin(angle(t))
  });
  const arcPath = (s: { start: number; end: number; i: number }, padFrac = 0) => {
    const raised = s.i === maxIdx ? 1.6 : 0;
    const outer = rOuter + raised;
    const inner = rInner - raised;
    // 悬停外弹时扩展边界角度，填补与相邻段之间露出的楔形缝隙，保证圆环闭合
    const start = s.start - padFrac;
    const end = s.end + padFrac;
    const p1 = pt(start, outer);
    const p2 = pt(end, outer);
    const p3 = pt(end, inner);
    const p4 = pt(start, inner);
    const large = end - start > 0.5 ? 1 : 0;
    return `M ${p1.x.toFixed(3)} ${p1.y.toFixed(3)} A ${outer} ${outer} 0 ${large} 1 ${p2.x.toFixed(3)} ${p2.y.toFixed(3)} L ${p3.x.toFixed(3)} ${p3.y.toFixed(3)} A ${inner} ${inner} 0 ${large} 0 ${p4.x.toFixed(3)} ${p4.y.toFixed(3)} Z`;
  };

  const hovered = hover !== null ? segs[hover] : null;
  const midT = (s: { start: number; end: number }) => (s.start + s.end) / 2;
  // 图标位于扇区角度中央，径向略偏外（参考图图标位于扇区外半部分）
  const midR = (rOuter + rInner) / 2 + 1.4;
  const iconSize = Math.round(size * 0.115); // 图标约为环宽的一半，与参考图一致
  // 悬停持仓文字跟随扇区（显示在公司名与占比在扇区附近）
  const tip = hovered ? pt(midT(hovered), rOuter + 4) : null;
  // 提示放在圆环容器外侧（按扇区主导方向选上/下/左/右），不遮挡中心头像
  const tipSide = (() => {
    if (!hovered) return "none";
    const a = angle(midT(hovered));
    if (a >= -Math.PI / 4 && a <= Math.PI / 4) return "right";
    if (a >= Math.PI / 4 && a <= (3 * Math.PI) / 4) return "bottom";
    if (a >= (3 * Math.PI) / 4 || a <= -(3 * Math.PI) / 4) return "left";
    return "top";
  })();
  const tipMid = tip ? { x: Math.max(12, Math.min(tip.x, 88)), y: Math.max(12, Math.min(tip.y, 88)) } : null;
  // 悬停扇区沿中角向外平滑弹出（过渡 320ms）
  const pop = hovered ? POP : 0;
  // 悬停段补足边界角度：弹出后相邻段不会露出深色缝隙（跨度越大、外缘处缝隙越大，按三角函数计算）
  const hoverPad = (s: { start: number; end: number; i: number }) => {
    if (!hovered || s.i !== hovered.i) return 0;
    const gap = pop * Math.sin(((s.end - s.start) / 2) * 2 * Math.PI);
    return Math.atan(gap / (rOuter + pop)) / (2 * Math.PI);
  };
  // 悬停段最后绘制（盖住边界），配合角度扩展让圆环始终连续
  const drawSegs = hovered ? [...segs.filter((s) => s.i !== hovered.i), hovered] : segs;
  const segTransform = (s: { i: number; start: number; end: number }) => {
    const a = angle(midT(s));
    return `translate(${(Math.cos(a) * pop).toFixed(2)}px, ${(Math.sin(a) * pop).toFixed(2)}px)`;
  };

  // 圆环 SVG（可条件放置：透明图时盖在人物之上遮住衣领，非透明图时在人物之下）
  const ringSvg = (
    <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full overflow-visible">
      {/* 完整底色环：保证环带连续、无黑色间隙（参考图圆环为一体） */}
      <path d={arcPath({ start: 0, end: 1, i: -1 })} fill={RING_BASE} />
      {/* 环体：无间隙扇形弧，颜色由亮到深；最大段最亮并突出 */}
      {drawSegs.map((s) => (
        <path
          key={s.h.code}
          d={arcPath(s, hoverPad(s))}
          fill={s.h.code === "OTHER" ? RING_BASE : ringShade(s.i, segs.length)}
          // 与自身同色的发丝描边：盖住相邻路径之间的亚像素抗锯齿细线，圆环无接缝
          stroke={s.h.code === "OTHER" ? RING_BASE : ringShade(s.i, segs.length)}
          strokeWidth="0.5"
          vectorEffect="non-scaling-stroke"
          opacity={hover === null ? 1 : hover === s.i ? 1 : 0.2}
          style={{
            transform: hover === s.i ? segTransform(s) : "translate(0px, 0px)",
            transition: "transform 320ms cubic-bezier(.22,.9,.26,1), opacity 200ms ease-out"
          }}
          className={`cursor-pointer ${hover === s.i ? "brightness-110" : ""}`}
          onMouseEnter={() => setHover(s.i)}
          onMouseLeave={() => setHover(null)}
        />
      ))}
    </svg>
  );

  return (
    <div
      className="relative flex-none"
      style={{ width: size, height: size }}
      onMouseLeave={() => {
        // 兜底：指针离开圆环时强制清空扇区与头像悬停，避免提示残留
        setHover(null);
        setAvatarHover(false);
      }}
    >
      {/* 人物：透明图头部在洞内、肩膀/衣领伸入环带被上方圆环遮挡（参考图）；非透明图圆形居中 */}
      <div
        role="button"
        aria-label={celeb.name}
        onMouseEnter={() => setAvatarHover(true)}
        onMouseLeave={() => setAvatarHover(false)}
        className={`absolute left-1/2 top-1/2 cursor-pointer ${
          avatarTransparent ? "" : "flex items-center justify-center overflow-hidden rounded-full font-bold text-white"
        }`}
        style={{
          width: size * (avatarTransparent ? 0.7 : 0.66),
          height: size * (avatarTransparent ? 0.7 : 0.66),
          fontSize: size * 0.16,
          transform: `translate(-50%, calc(-50% - ${avatarHover ? 5 : 3}px))`,
          filter: avatarHover
            ? "drop-shadow(0 14px 28px rgba(5,10,22,.85))"
            : "drop-shadow(0 6px 18px rgba(5,10,22,.6))",
          transition: "transform 320ms cubic-bezier(.22,.9,.26,1), filter 320ms ease-out",
          ...(avatarTransparent
            ? {
                // 衣领/肩膀向下柔和渐隐（mask 底部淡出），悬停时不再生硬突出
                WebkitMaskImage:
                  "linear-gradient(to bottom, #000 58%, rgba(0,0,0,.82) 74%, rgba(0,0,0,.35) 88%, transparent 100%)",
                maskImage:
                  "linear-gradient(to bottom, #000 58%, rgba(0,0,0,.82) 74%, rgba(0,0,0,.35) 88%, transparent 100%)"
              }
            : {
                WebkitMaskImage: "radial-gradient(circle, #000 90%, rgba(0,0,0,.55) 96%, transparent 100%)",
                maskImage: "radial-gradient(circle, #000 90%, rgba(0,0,0,.55) 96%, transparent 100%)"
              })
        }}
      >
        {/* 低调底色占位（无文字）：非透明头像用浅灰圆盘，透明头像留空；图片加载完成即覆盖，刷新不闪现中文名 */}
        <span className={`absolute inset-0 rounded-full ${avatarTransparent ? "bg-transparent" : "bg-bg-gray/70 dark:bg-white/10"}`} />
        {celeb.avatar && !avatarBroken && (
          <img
            src={celeb.avatar}
            alt={celeb.name}
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
            onError={() => setAvatarBroken(true)}
          />
        )}
      </div>
      {/* 非透明头像：圆环在人物之下（圆形头像完整显示） */}
      {!avatarTransparent && ringSvg}
      {/* 悬停光环（圆环之上，柔光淡入） */}
      <div
        className={`pointer-events-none absolute left-1/2 top-1/2 h-[92%] w-[92%] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-300 ${
          avatarHover ? "opacity-100" : "opacity-0"
        }`}
        style={{ boxShadow: "0 0 0 1.5px rgba(43,93,227,.32), 0 0 28px rgba(43,93,227,.32)" }}
      />
      {/* 透明头像：圆环在人物之上，盖住衣领/肩膀（参考图「衣领被扇形遮挡」） */}
      {avatarTransparent && ringSvg}
      {/* 股票 Logo 落在扇区角度中央略偏外（不可交互，避免遮挡扇区悬停；过小的段不放置） */}
      {segs.map((s) => {
        if (s.h.code === "OTHER" || s.frac < 0.04) return null;
        const m = pt(midT(s), midR);
        const isHov = hover === s.i;
        const a = angle(midT(s));
        // 悬停时 Logo 随扇区一起外移 + 轻微外倾 + 放大，避免呆板
        const dx = isHov ? Math.cos(a) * pop : 0;
        const dy = isHov ? Math.sin(a) * pop : 0;
        const tilt = isHov ? Math.sin(a) * 7 : 0;
        return (
          <div
            key={`logo-${s.h.code}`}
            className="pointer-events-none absolute"
            style={{
              left: `${m.x}%`,
              top: `${m.y}%`,
              opacity: hover === null || isHov ? 1 : 0.4,
              transform: `translate(calc(-50% + ${dx.toFixed(2)}px), calc(-50% + ${dy.toFixed(2)}px)) rotate(${tilt.toFixed(2)}deg) scale(${isHov ? 1.08 : 1})`,
              transition: "transform 320ms cubic-bezier(.22,.9,.26,1), opacity 200ms ease-out"
            }}
          >
            <CelebLogo code={s.h.code} name={s.h.name} size={iconSize} ring market={s.h.market} />
          </div>
        );
      })}
      {/* 悬停当前扇区：名称 + 占比 */}
      {hovered && tipMid && (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-full bg-black/85 px-2.5 py-1 text-[10.5px] font-semibold text-white shadow-lg backdrop-blur dark:bg-white/95 dark:text-ink"
          style={
            tipSide === "right"
              ? { left: "calc(100% + 8px)", top: `${tipMid.y}%`, transform: "translateY(-50%)" }
              : tipSide === "left"
                ? { right: "calc(100% + 8px)", top: `${tipMid.y}%`, transform: "translateY(-50%)" }
                : tipSide === "bottom"
                  ? { top: "calc(100% + 8px)", left: `${tipMid.x}%`, transform: "translateX(-50%)" }
                  : { bottom: "calc(100% + 8px)", left: `${tipMid.x}%`, transform: "translateX(-50%)" }
          }
        >
          <span
            className="mr-1 inline-block h-2 w-2 rounded-full align-[-1px]"
            style={{ background: hovered.h.code === "OTHER" ? RING_BASE : ringShade(hovered.i, segs.length) }}
          />
          {hovered.h.name} · {hovered.h.weight.toFixed(1)}%
        </div>
      )}
    </div>
  );
}

function TradeRow({ code, name, changePct, action }: { code: string; name: string; changePct: number; action: string }) {
  const buy = action.includes("买入") || action.includes("增仓") || action.includes("建仓") || action.includes("增持");
  return (
    <div className="flex items-center gap-2 rounded-xl border border-edge/80 bg-white/60 px-2.5 py-1.5 text-xs transition-colors hover:border-edge-strong dark:border-[#3b4354]/70 dark:bg-white/[0.04] dark:hover:border-[#4a5468]">
      <span className="font-semibold text-ink">{code}</span>
      <span className={`tabular-nums ${changePct >= 0 ? UP : DOWN}`}>
        {changePct >= 0 ? "+" : ""}
        {changePct.toFixed(2)}%
      </span>
      <span
        className={`ml-auto rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
          buy ? "bg-up-bg text-up" : "bg-down-bg text-down"
        }`}
      >
        {action}
      </span>
    </div>
  );
}

type ChartRange = "3m" | "1y" | "5y";

const CHART_RANGES: { key: ChartRange; label: string }[] = [
  { key: "3m", label: "近3月" },
  { key: "1y", label: "近1年" },
  { key: "5y", label: "近5年" }
];

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

/* 对比基准指数线条色（可扩展：后续加纳指 / 上证 / 恒生等时依次取色即可） */
const BENCH_COLORS = ["#9aa1ab", "#7d8794", "#b9c0ca", "#5f6b7d"];

/* 按区间生成单条序列：近3月取近1年序列末尾 3 个月并重新归零；近1年用原始月序列；
   近5年以 60 个月平滑曲线表达，终点对齐 end，后 12 个月沿用近1年实际形态 */
function buildSeriesForRange(base: number[], range: ChartRange, end: number): number[] {
  if (range === "3m") {
    const p = base.slice(-3);
    return p.map((v) => v - p[0]);
  }
  if (range === "1y") {
    return base.map((v) => v - base[0]);
  }
  const months = 60;
  const tailLen = Math.min(base.length, 12);
  const headLen = months - tailLen;
  const last = base[base.length - 1] || 1;
  const headEnd = end * Math.pow(headLen / (months - 1 || 1), 1.45);
  const out: number[] = [];
  for (let i = 0; i < months; i++) {
    if (i < headLen) {
      const t = i / (headLen - 1 || 1);
      out.push(Math.max(0, headEnd * Math.pow(t, 1.45)));
    } else {
      const j = i - headLen;
      out.push(headEnd + (base[j] / last) * (end - headEnd));
    }
  }
  return out;
}

/* 组合收益 + 全部对比基准指数（benchmarks 可扩展，后续加指数只需在数据里追加条目） */
function buildRangeSeries(
  returns: Celeb["returns"],
  range: ChartRange
): { data: number[]; benchmarks: { code: string; name: string; points: number[] }[] } {
  const base = Array.isArray(returns.points) && returns.points.length >= 2 ? returns.points : [0, returns.y1];
  const data = buildSeriesForRange(base, range, returns.y5 || 0);
  const ratio = Math.max(1, (returns.y5 || 0) / Math.max(1, returns.y1 || 1));
  const benchmarks = (returns.benchmarks ?? []).map((b) => {
    const bBase = Array.isArray(b.points) && b.points.length >= 2 ? b.points : [0, b.y1];
    const end = range === "5y" ? (b.y1 || 0) * ratio : 0;
    return { code: b.code, name: b.name, points: buildSeriesForRange(bBase, range, end) };
  });
  return { data, benchmarks };
}

function monthDates(n: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, now.getDate());
    out.push(`${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`);
  }
  return out;
}

/* 走势图：组合收益（蓝）+ 多个基准指数（灰系），悬停十字光标 + 圆点，图例数值联动 */
function ReturnChart({
  series,
  onHover
}: {
  series: { data: number[]; benchmarks: { code: string; name: string; points: number[] }[] };
  onHover: (i: number | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const W = 640;
  const H = 148;
  const padL = 46;
  const padR = 12;
  const padT = 10;
  const padB = 20;
  const n = series.data.length;
  const dates = useMemo(() => monthDates(n), [n]);
  const all = [0, ...series.data, ...series.benchmarks.flatMap((b) => b.points)];
  let minV = Math.min(...all);
  let maxV = Math.max(...all);
  const pad = (maxV - minV) * 0.12 || 2;
  minV -= pad;
  maxV += pad;
  const x = (i: number) => padL + (i / (n - 1 || 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - minV) / (maxV - minV || 1)) * (H - padT - padB);
  const line = (arr: number[]) => arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const areaPath = (arr: number[]) => {
    if (arr.length < 2) return "";
    const pts = arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" L ");
    return `M ${x(0).toFixed(1)},${(H - padB).toFixed(1)} L ${pts} L ${x(arr.length - 1).toFixed(1)},${(H - padB).toFixed(1)} Z`;
  };
  const yTicks = Array.from({ length: 5 }, (_, i) => minV + ((maxV - minV) * i) / 4);
  const h = hoverIdx !== null ? Math.max(0, Math.min(n - 1, hoverIdx)) : null;
  const xPct = h !== null ? (x(h) / W) * 100 : 0;
  const yComboPct = h !== null ? (y(series.data[h]) / H) * 100 : 0;
  const gradId = useMemo(() => `pf-grad-${Math.random().toString(36).slice(2, 8)}`, []);

  function handleMove(e: ReactMouseEvent<HTMLDivElement> | ReactTouchEvent<HTMLDivElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || n < 2) return;
    const clientX = "touches" in e ? (e.touches[0]?.clientX ?? rect.left) : e.clientX;
    const px = ((clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - padL) / (W - padL - padR)) * (n - 1));
    const clamped = Math.max(0, Math.min(n - 1, i));
    setHoverIdx(clamped);
    onHover(clamped);
  }

  return (
    <div
      className="relative w-full cursor-crosshair select-none"
      onMouseMove={handleMove}
      onMouseLeave={() => {
        setHoverIdx(null);
        onHover(null);
      }}
      onTouchMove={handleMove}
    >
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0071e3" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#0071e3" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* 横向点状网格 + Y 轴刻度（淡、不抢眼，参考图风格） */}
        {yTicks.map((tv, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(tv)} y2={y(tv)} strokeDasharray="1 5" strokeWidth="1" vectorEffect="non-scaling-stroke" className="stroke-[#c9cdd6] opacity-60 dark:stroke-[#2a2f3a]" />
            <text x={padL - 6} y={y(tv) + 3} textAnchor="end" fontSize="10" className="fill-current text-muted">
              {tv.toFixed(1)}%
            </text>
          </g>
        ))}
        {/* 竖向点状网格（四分位，极淡） */}
        {[0.25, 0.5, 0.75].map((f, i) => (
          <line key={i} x1={x(f * (n - 1))} x2={x(f * (n - 1))} y1={padT} y2={H - padB} strokeDasharray="1 5" strokeWidth="1" vectorEffect="non-scaling-stroke" className="stroke-[#c9cdd6] opacity-30 dark:stroke-[#2a2f3a]" />
        ))}
        {/* X 轴首尾 + 中间日期 */}
        <text x={x(0)} y={H - 5} textAnchor="start" fontSize="10" className="fill-current text-muted">{dates[0]}</text>
        <text x={x((n - 1) / 2)} y={H - 5} textAnchor="middle" fontSize="10" className="fill-current text-muted">{dates[Math.round((n - 1) / 2)]}</text>
        <text x={x(n - 1)} y={H - 5} textAnchor="end" fontSize="10" className="fill-current text-muted">{dates[n - 1]}</text>

        {/* 组合收益面积渐变（moomoo 分时风格） */}
        <path d={areaPath(series.data)} fill={`url(#${gradId})`} />
        {/* 基准指数（灰系，可多条） */}
        {series.benchmarks.map((b, i) => (
          <polyline key={b.code} points={line(b.points)} fill="none" stroke={BENCH_COLORS[i % BENCH_COLORS.length]} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
        ))}
        {/* 组合收益（蓝）：霓虹发光 + 悬停主线变粗 */}
        <polyline points={line(series.data)} fill="none" stroke="#0071e3" strokeWidth={h !== null ? 9 : 6} opacity={h !== null ? 0.3 : 0.2} className="transition-all duration-200" vectorEffect="non-scaling-stroke" />
        <polyline points={line(series.data)} fill="none" stroke="#0071e3" strokeWidth={h !== null ? 3.8 : 2.4} className="transition-all duration-200" vectorEffect="non-scaling-stroke" />
      </svg>

      {/* 悬停悬浮层：CSS 过渡让十字光标 / 圆点 / 标签平滑滑动并淡入淡出 */}
      <div className={`pointer-events-none absolute inset-0 transition-opacity duration-200 ${h !== null ? "opacity-100" : "opacity-0"}`}>
        {h !== null && (
          <>
            {/* 垂直虚线 */}
            <div
              className="absolute -translate-x-1/2 border-l border-dashed border-[#9aa1ab]/70 transition-[left] duration-150 ease-out"
              style={{ left: `${xPct}%`, top: 9, bottom: 19 }}
            />
            {/* 水平虚线（当前组合收益位置） */}
            <div
              className="absolute -translate-y-1/2 border-t border-dashed border-[#9aa1ab]/40 transition-[top] duration-150 ease-out"
              style={{ top: `${yComboPct}%`, left: padL - 1, right: padR - 1 }}
            />
            {/* 左侧数值标签 */}
            <div
              className="absolute -translate-y-1/2 whitespace-nowrap rounded bg-black/75 px-1 py-[1px] text-[9px] font-bold text-white transition-[top] duration-150 ease-out"
              style={{ left: 3, top: `${yComboPct}%` }}
            >
              {fmtPct(series.data[h])}
            </div>
            {/* 各基准指数圆点（小） */}
            {series.benchmarks.map((b, i) => (
              <div
                key={b.code}
                className="absolute h-[6px] w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left,top] duration-150 ease-out"
                style={{ left: `${xPct}%`, top: `${(y(b.points[h]) / H) * 100}%`, background: BENCH_COLORS[i % BENCH_COLORS.length] }}
              />
            ))}
            {/* 组合收益圆点（大） */}
            <div
              className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand shadow-[0_0_6px_rgba(0,113,227,.55)] transition-[left,top] duration-150 ease-out"
              style={{ left: `${xPct}%`, top: `${yComboPct}%` }}
            />
            {/* 底部日期标签 */}
            <div
              className="absolute -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1 py-[1px] text-[8.5px] font-semibold text-white transition-[left] duration-150 ease-out"
              style={{ left: `${xPct}%`, bottom: 2 }}
            >
              {dates[h]}
            </div>
            {/* 右侧信息浮窗（moomoo 风格） */}
            <div className="absolute right-2 top-2 min-w-[118px] rounded-lg border border-white/10 bg-black/75 px-2.5 py-1.5 text-[10px] text-white shadow-lg backdrop-blur">
              <div className="mb-1 border-b border-white/10 pb-1 font-semibold">{dates[h]}</div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                  组合收益
                </span>
                <b className={`tabular-nums ${series.data[h] >= 0 ? UP : DOWN}`}>{fmtPct(series.data[h])}</b>
              </div>
              {series.benchmarks.map((b, i) => (
                <div key={b.code} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: BENCH_COLORS[i % BENCH_COLORS.length] }} />
                    {b.name}
                  </span>
                  <b className={`tabular-nums ${b.points[h] >= 0 ? UP : DOWN}`}>{fmtPct(b.points[h])}</b>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* 收益分析卡片：三大时段数值 + 区间切换 + 图例联动 + 走势图 + 展开/收起 */
function ReturnAnalysis({ celeb }: { celeb: Celeb }) {
  const [range, setRange] = useState<ChartRange>("1y");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(true);
  const { returns } = celeb;
  const series = useMemo(() => buildRangeSeries(returns, range), [returns, range]);
  const n = series.data.length;
  const idx = hoverIdx !== null && hoverIdx < n ? hoverIdx : n - 1;
  const comboVal = series.data[idx] ?? 0;

  return (
    <div className="card max-w-xl p-4 sm:p-5">
      <div className="mb-2.5 flex items-center gap-1.5 text-sm font-bold text-ink">
        收益分析
        <span title="组合收益与标普500为估算走势，仅供参考" className="inline-flex h-4 w-4 items-center justify-center rounded-full text-faint">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8h.01" />
            <path d="M11 12h1v4h1" />
          </svg>
        </span>
      </div>

      {/* 三大时段数值 */}
      <div className="grid grid-cols-3 divide-x divide-edge text-center">
        {[
          ["近1年", returns.y1],
          ["近3年", returns.y3],
          ["近5年", returns.y5]
        ].map(([label, v]) => (
          <div key={label as string} className="px-2">
            <div className="text-[10px] text-faint">{label}</div>
            <div className={`mt-1 text-lg font-extrabold tabular-nums sm:text-xl ${(v as number) >= 0 ? UP : DOWN}`}>
              {fmtPct(v as number)}
            </div>
          </div>
        ))}
      </div>

      {expanded && (
        <>
          {/* 区间切换 */}
          <div className="mt-3 flex w-fit gap-1 rounded-full border border-edge bg-bg-gray/50 p-1 dark:bg-white/[0.04]">
            {CHART_RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => {
                  setRange(r.key);
                  setHoverIdx(null);
                }}
                className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-colors ${range === r.key ? "seg-active" : "text-muted hover:text-ink"}`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* 图例 + 联动数值（基准指数随数据扩展） */}
          <div className="mt-2.5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[11px]">
            <span className="flex items-center gap-1.5 text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" />
              组合收益
              <b className={`tabular-nums ${comboVal >= 0 ? UP : DOWN}`}>{fmtPct(comboVal)}</b>
            </span>
            {series.benchmarks.map((b, i) => {
              const v = b.points[idx] ?? 0;
              return (
                <span key={b.code} className="flex items-center gap-1.5 text-muted">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: BENCH_COLORS[i % BENCH_COLORS.length] }} />
                  {b.name}
                  <b className={`tabular-nums ${v >= 0 ? UP : DOWN}`}>{fmtPct(v)}</b>
                </span>
              );
            })}
          </div>

          {/* 走势图 */}
          <div className="mt-2">
            <ReturnChart series={series} onHover={setHoverIdx} />
          </div>
        </>
      )}

      {/* 收起 / 展开全部 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mx-auto mt-3 flex items-center gap-1 text-[11px] font-semibold text-muted transition-colors hover:text-ink"
      >
        {expanded ? "收起" : "展开全部"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </div>
  );
}

export default function CelebsView({
  isAdmin = false,
  initialAvatars
}: {
  isAdmin?: boolean;
  initialAvatars?: Record<string, string>;
}) {
  const [active, setActive] = useState<Celeb | null>(null);
  // 初始值统一用默认（服务端 / 客户端首帧一致，避免 hydration 不匹配），
  // SSR 首帧即带服务端读出的最新自定义头像，缓存的自定义头像在挂载后的客户端副作用里秒出兜底
  const [celebs, setCelebs] = useState<Celeb[]>(() =>
    initialAvatars && Object.keys(initialAvatars).length > 0
      ? CELEBS.map((c) => (initialAvatars[c.id] ? { ...c, avatar: initialAvatars[c.id] } : c))
      : CELEBS
  );
  const [detail, setDetail] = useState<Record<string, string>>({});
  const [source, setSource] = useState<string>("sample");
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [avatarTarget, setAvatarTarget] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState<string | null>(null);
  const avatarFileRef = useRef<HTMLInputElement | null>(null);
  const pendingIdRef = useRef<string | null>(null);

  // 预加载全部名人头像：刷新 / 睡眠唤醒后尽早并行加载，缩短首屏等待
  useEffect(() => {
    const urls = new Set<string>();
    CELEBS.forEach((c) => c.avatar && urls.add(c.avatar));
    (initialAvatars ? Object.values(initialAvatars) : []).forEach((u) => u && urls.add(u));
    urls.forEach((u) => {
      const img = new Image();
      img.src = u;
    });
  }, [initialAvatars]);

  // 详情页 URL 同步：/celebs?celeb=<id>，刷新 / 前进后退保持当前名人，无感不刷新
  function openCeleb(c: Celeb | null) {
    pendingIdRef.current = c ? c.id : null;
    setActive(c);
    const base = window.location.pathname;
    const next = c ? `${base}?celeb=${encodeURIComponent(c.id)}` : base;
    if (window.location.search !== (c ? `?celeb=${encodeURIComponent(c.id)}` : "")) {
      window.history.pushState({}, "", next);
    }
  }

  useLayoutEffect(() => {
    const id = new URLSearchParams(window.location.search).get("celeb");
    if (!id) return;
    pendingIdRef.current = id;
    // 首帧兜底：用示例 + 自定义头像先渲染，防止空白；pendingId 保留到真实数据到位
    const over = loadAvatarCache();
    const fallback = CELEBS.find((x) => x.id === id);
    if (fallback) setActive(over[fallback.id] ? { ...fallback, avatar: over[fallback.id] } : fallback);
    // 秒出缓存数据（含自定义头像与真实持仓），避免停留在示例数据
    const saved = loadCelebsCache();
    if (Array.isArray(saved.celebs) && saved.celebs.length > 0) {
      const c = saved.celebs.find((x) => x.id === id);
      if (c) {
        setActive(c);
        setDetail(saved.detail ?? {});
        setSource(saved.source ?? "sample");
      }
    }
  }, []);

  // 浏览器前进 / 后退：跟随 ?celeb= 变化切换详情与列表
  useEffect(() => {
    const onPop = () => {
      const id = new URLSearchParams(window.location.search).get("celeb");
      if (!id) {
        setActive(null);
        pendingIdRef.current = null;
        return;
      }
      pendingIdRef.current = id;
      const c = celebs.find((x) => x.id === id) || CELEBS.find((x) => x.id === id);
      if (c) setActive(c);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [celebs]);

  // 缓存头像在绘制前应用，刷新不闪现原始头像且不影响 hydration
  useLayoutEffect(() => {
    const over = loadAvatarCache();
    if (Object.keys(over).length > 0) {
      setCelebs((prev) => prev.map((c) => (over[c.id] ? { ...c, avatar: over[c.id] } : c)));
      setActive((prev) => (prev && over[prev.id] ? { ...prev, avatar: over[prev.id] } : prev));
    }
    // 名人列表缓存：刷新先秒出真实列表（含来源与自定义头像），再后台拉最新
    const saved = loadCelebsCache();
    if (Array.isArray(saved.celebs) && saved.celebs.length > 0) {
      setCelebs(saved.celebs.map(withBenchmarkFallback));
      if (saved.detail) setDetail(saved.detail);
      if (saved.source) setSource(saved.source);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/celebs")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.celebs?.length) return;
        setCelebs(data.celebs);
        setDetail(data.detail ?? {});
        setSource(data.source);
        // 深链 / 前进后退恢复：真实数据到位后用最新数据定位，避免停留在示例
        if (pendingIdRef.current) {
          const c = data.celebs.find((x: { id: string }) => x.id === pendingIdRef.current);
          if (c) {
            setActive(c);
            pendingIdRef.current = null;
          }
        }
        saveCelebsCache({ celebs: data.celebs, detail: data.detail ?? {}, source: data.source });
        const over: Record<string, string> = {};
        data.celebs.forEach((c: { id: string; avatar?: string }) => {
          if (c.avatar) over[c.id] = c.avatar;
        });
        saveAvatarCache(over);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const sourceLabel =
    source === "sec-edgar"
      ? "SEC EDGAR 13F / Form 4 实时拉取"
      : source === "cache"
        ? "缓存数据（24h 内）"
        : "示例数据（SEC 暂不可达时自动兜底）";

  function updateAvatar(id: string, url: string) {
    setCelebs((prev) => prev.map((c) => (c.id === id ? { ...c, avatar: url } : c)));
    setActive((prev) => (prev && prev.id === id ? { ...prev, avatar: url } : prev));
    const over = loadAvatarCache();
    over[id] = url;
    saveAvatarCache(over);
  }

  async function uploadCelebAvatar(id: string, file: File) {
    setUploadingAvatar(id);
    try {
      const fd = new FormData();
      fd.append("id", id);
      fd.append("file", file);
      const res = await fetch("/api/celebs/avatar", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "上传失败");
      updateAvatar(id, data.avatar);
      showToast(`${celebs.find((c) => c.id === id)?.name ?? ""}头像已更新`, "ok");
      setAvatarPickerOpen(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传头像失败", "err");
    } finally {
      setUploadingAvatar(null);
    }
  }

  if (active) {
    const up = active.gain250 >= 0;
    return (
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => openCeleb(null)}
          className="inline-flex w-fit items-center gap-1.5 rounded-full border border-edge bg-transparent px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-bg-gray hover:text-ink dark:border-[#3b4354] dark:text-[#e7ebf1] dark:hover:bg-white/10"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
            <path d="m15 18-6-6 6-6" />
          </svg>
          返回
        </button>

        <div className="card flex flex-wrap items-center gap-6 p-5 pr-20">
          <CelebRing celeb={active} size={152} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-ink">{active.name}持仓</h2>
              <SourceBadge celeb={active} detail={detail[active.id]} />
            </div>
            <p className="mt-0.5 text-xs text-muted">{active.title}</p>
            <div className={`mt-2 text-3xl font-extrabold tabular-nums ${up ? UP : DOWN}`}>
              {active.gain250 >= 0 ? "+" : ""}
              {active.gain250.toFixed(2)}%
            </div>
            <div className="mt-1 text-xs text-faint">250日涨幅 · {active.updated}</div>
          </div>
        </div>

        <div className="card overflow-hidden p-0">
          <div className="border-b border-edge px-5 py-3 text-sm font-bold text-ink">持仓明细</div>
          <div className="grid grid-cols-[1.6fr_0.8fr_0.8fr_0.7fr_0.8fr_0.8fr] items-center gap-2 border-b border-edge bg-bg-gray/60 px-5 py-2 text-[11px] font-semibold text-muted dark:bg-white/5">
            <span>股票</span>
            <span className="text-right">现价</span>
            <span className="text-right">涨跌幅</span>
            <span className="text-right">持仓占比</span>
            <span className="text-right">目标价</span>
            <span className="text-right">涨跌距</span>
          </div>
          {active.holdings.map((h: CelebHolding) => {
            const gap = h.target ? ((h.target - h.price) / h.price) * 100 : null;
            return (
              <div key={h.code} className="grid grid-cols-[1.6fr_0.8fr_0.8fr_0.7fr_0.8fr_0.8fr] items-center gap-2 border-b border-edge px-5 py-3 text-sm last:border-0">
                <span className="flex min-w-0 items-center gap-2.5">
                  <CelebLogo code={h.code} name={h.name} size={26} market={h.market} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-ink">{h.code}</span>
                    <span className="block truncate text-[11px] text-faint">{h.name}</span>
                  </span>
                </span>
                <span className="text-right tabular-nums text-ink-2">{h.price ? `$${h.price.toFixed(2)}` : "—"}</span>
                <span className={`text-right tabular-nums ${h.changePct >= 0 ? UP : DOWN}`}>
                  {h.changePct >= 0 ? "+" : ""}
                  {h.changePct.toFixed(2)}%
                </span>
                <span className="text-right tabular-nums text-ink-2">{h.weight.toFixed(1)}%</span>
                <span className="text-right tabular-nums text-ink-2">{h.target ? `$${h.target.toFixed(0)}` : "—"}</span>
                <span className={`text-right tabular-nums ${gap !== null && gap >= 0 ? UP : DOWN}`}>
                  {gap !== null ? `${gap >= 0 ? "+" : ""}${gap.toFixed(1)}%` : "—"}
                </span>
              </div>
            );
          })}
        </div>

        <ReturnAnalysis celeb={active} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <input
        ref={avatarFileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          const id = avatarTarget;
          e.target.value = "";
          setAvatarTarget(null);
          if (f && id) void uploadCelebAvatar(id, f);
        }}
      />
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="relative">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold">名人持仓</h2>
            {isAdmin && (
              <button
                type="button"
                title="名人管理"
                onClick={() => setManageOpen(true)}
                className="flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-bg-gray hover:text-brand-deep dark:hover:bg-white/10 dark:hover:text-[#8ec2ff]"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                </svg>
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                title="修改名人头像"
                onClick={() => setAvatarPickerOpen((v) => !v)}
                className="flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-bg-gray hover:text-brand-deep dark:hover:bg-white/10 dark:hover:text-[#8ec2ff]"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>
            )}
          </div>
          {avatarPickerOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setAvatarPickerOpen(false)} />
              <div className="absolute left-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-card border border-edge bg-white p-1.5 shadow-pop dark:border-[#3b4354] dark:bg-[#1c1c1e]">
                <p className="px-2 pb-1 pt-1.5 text-[11px] text-faint">选择名人，上传新头像</p>
                {celebs.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={uploadingAvatar === c.id}
                    onClick={() => {
                      setAvatarTarget(c.id);
                      avatarFileRef.current?.click();
                    }}
                    className="group flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-bg-gray disabled:opacity-50 dark:hover:bg-white/[0.06]"
                  >
                    <span className="relative flex h-7 w-7 flex-none items-center justify-center overflow-hidden rounded-full ring-1 ring-black/10 dark:ring-white/15">
                      <img
                        src={c.avatar || undefined}
                        alt=""
                        className="h-full w-full rounded-full object-cover transition-transform duration-300 group-hover:scale-110"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                      <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                          <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
                          <circle cx="12" cy="13" r="3" />
                        </svg>
                      </span>
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{c.name}</span>
                    {uploadingAvatar === c.id && <span className="text-[11px] text-faint">上传中…</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <span className="mr-4 inline-flex items-center gap-1.5 rounded-full border border-edge px-2.5 py-1 text-[11px] text-muted dark:border-[#3b4354] dark:text-[#aab2c0]">
          <span className={`h-1.5 w-1.5 rounded-full ${source === "sec-edgar" ? "bg-up" : source === "cache" ? "bg-brand" : "bg-faint"}`} />
          {sourceLabel}
        </span>
      </div>
      {manageOpen && <CelebsManageModal onClose={() => setManageOpen(false)} onChanged={() => setRefreshKey((k) => k + 1)} />}

      {/* 单行卡片：左侧数据，右侧圆环 */}
      <div className="flex flex-col gap-4">
        {celebs.map((c) => {
          const up = c.gain250 >= 0;
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
          onClick={() => openCeleb(c)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openCeleb(c);
                }
              }}
              className="card group flex w-full cursor-pointer items-center gap-5 p-5 pr-36 text-left transition-all duration-200 hover:border-brand/35 hover:shadow-pop"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-bold text-ink">{c.name}持仓</span>
                  <SourceBadge celeb={c} detail={detail[c.id]} />
                  <span className="truncate text-[11px] text-faint">{c.title}</span>
                </div>
                <div className="mt-1.5 flex items-end gap-2">
                  <span className={`text-[26px] font-extrabold leading-none tabular-nums ${up ? UP : DOWN}`}>
                    {c.gain250 >= 0 ? "+" : ""}
                    {c.gain250.toFixed(2)}%
                  </span>
                  <span className="pb-0.5 text-[11px] text-faint">250日涨幅 · {c.updated}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {c.trades.map((t) => (
                    <TradeRow key={t.code} {...t} />
                  ))}
                </div>
                <div className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-brand-deep opacity-70 transition-opacity group-hover:opacity-100 dark:text-[#7fb4ff]">
                  查看明细
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 transition-transform group-hover:translate-x-0.5">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </div>
              </div>
              <div className="flex-none">
                <CelebRing celeb={c} size={138} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
