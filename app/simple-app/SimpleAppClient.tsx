"use client";

import { TimeMachineMenu } from "@/components/TimeMachine";
import Script from "next/script";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconArrowDown, IconCheck, IconExclamationMark, IconLoader2 } from "@tabler/icons-react";
import echarts from "@/lib/echarts";

const WINDOW_KEY = "fire-simple-win";

export default function SimpleAppClient() {
  const [pullDistance, setPullDistance] = useState(0);
  const [pullState, setPullState] = useState<"idle" | "pulling" | "ready" | "refreshing" | "success" | "error">("idle");
  const pullRef = useRef({ active: false, refreshing: false, startX: 0, startY: 0, distance: 0 });

  useLayoutEffect(() => {
    const wasDark = document.documentElement.classList.contains("dark");
    document.documentElement.classList.add("simple-app-active");
    try {
      document.documentElement.classList.toggle("dark", localStorage.getItem("fire-simple-theme") === "dark");
      const saved = JSON.parse(localStorage.getItem(WINDOW_KEY) || "null") as { w?: number } | null;
      if (saved && Number.isFinite(saved.w)) {
        document.documentElement.style.setProperty("--saved-win-w", `${Math.max(360, saved.w!)}px`);
      }
    } catch {}
    window.remountSimpleApp?.();
    return () => {
      document.documentElement.classList.remove("simple-app-active", "simple-app-ready");
      document.documentElement.classList.toggle("dark", wasDark);
    };
  }, []);

  useEffect(() => {
    const chartObservers = new Map<HTMLElement, ResizeObserver>();
    window.mountSimpleCashflowCharts = (payload) => {
      chartObservers.forEach((observer, element) => {
        if (!element.isConnected) { observer.disconnect(); echarts.getInstanceByDom(element)?.dispose(); chartObservers.delete(element); }
      });
      document.querySelectorAll<HTMLElement>(".cf-echart").forEach((element) => {
        if (element.clientWidth < 40) {
          window.setTimeout(() => window.mountSimpleCashflowCharts?.(payload), 80);
          return;
        }
        const mode = element.dataset.mode || "combined";
        const metric = element.dataset.metric || "amount";
        const compact = element.dataset.full !== "true";
        const narrow = element.clientWidth < 700;
        const veryNarrow = element.clientWidth < 340;
        const valueText = (value: number, base: number) => metric === "ratio"
          ? `${base ? Math.round(value / base * 10000) / 100 : 0}%`
          : Math.abs(value) >= 10000 ? `${Math.round(value / 100) / 100}万` : value.toLocaleString("zh-CN");
        const shown = (name: string, value: number, base: number) => metric === "hidden" ? name : `${name} ${valueText(value, base)}`;
        const income = payload.income.filter((item) => item.value > 0);
        const expenses = payload.expenses.filter((item) => item.value > 0);
        const node = (name:string, depth:number, text:string, color:string, position:"left"|"right"|"top"|"bottom" = "right", extra:Record<string, unknown> = {}) => ({
          name, depth, displayLabel:text, itemStyle:{ color, ...extra }, label:{ position, align:position === "left" ? "right" : position === "right" ? "left" : "center" }
        });
        let nodes: Array<Record<string, unknown>> = [], links: Array<Record<string, unknown>> = [];
        if (mode === "expense") {
          const groups = [
            { key:"stable", name:"稳定支出", node:"#DB7960", flow:"#F1C9BF" },
            { key:"flexible", name:"弹性支出", node:"#DA944E", flow:"#F1D3B7" },
            { key:"other", name:"其他支出", node:"#B9A15B", flow:"#EADFB4" }
          ].map((group) => ({ ...group, value: expenses.filter((item) => item.type === group.key).reduce((sum,item) => sum + item.value,0) })).filter((group) => group.value > 0);
          nodes = [node("expense-total",0,shown("预估支出",payload.expensesTotal,payload.expensesTotal),"#DE7E4E","left")];
          groups.forEach((group) => {
            nodes.push(node(`group-${group.key}`,1,shown(group.name,group.value,payload.expensesTotal),group.node,group.key === "flexible" ? "bottom" : "top"));
            links.push({ source:"expense-total", target:`group-${group.key}`, value:group.value, lineStyle:{ color:group.flow } });
            expenses.filter((item) => item.type === group.key).forEach((item,index) => {
              const id=`expense-${group.key}-${index}`;
              nodes.push(node(id,2,shown(item.name,item.value,payload.expensesTotal),group.node,"right"));
              links.push({ source:`group-${group.key}`, target:id, value:item.value, lineStyle:{ color:group.flow } });
            });
          });
        } else {
          const chartIncome = compact ? [{ name:income.length === 1 ? income[0].name : "收入", value:payload.incomeTotal }] : income;
          nodes = [
            ...chartIncome.map((item,index) => node(`income-${index}`,0,shown(item.name,item.value,payload.incomeTotal),"#3DABCC","left")),
            node("income-total",1,shown("预估收入",payload.incomeTotal,payload.incomeTotal),"#3DABCC","top"),
            node("expense-total",compact?3:2,shown("预估支出",payload.expensesTotal,payload.incomeTotal),"#DE7E4E",compact ? "right" : "top")
          ];
          chartIncome.forEach((item,index) => links.push({ source:`income-${index}`, target:"income-total", value:item.value, lineStyle:{ color:"#BEE8F4" } }));
          if (payload.expensesTotal > 0) links.push({ source:"income-total", target:"expense-total", value:payload.expensesTotal, lineStyle:{ color:"#F1CBB8" } });
          if (payload.surplus > 0) links.push({ source:"income-total", target:"surplus", value:payload.surplus, lineStyle:{ color:"#C5E5E2" } });
          if (!compact) expenses.forEach((item,index) => {
            const palette=item.type === "stable" ? ["#DB7960","#F1C9BF"] : item.type === "flexible" ? ["#DA944E","#F1D3B7"] : ["#B9A15B","#EADFB4"];
            const id=`expense-item-${index}`;
            nodes.push(node(id,3,shown(item.name,item.value,payload.incomeTotal),palette[0],"right"));
            links.push({ source:"expense-total", target:id, value:item.value, lineStyle:{ color:palette[1] } });
          });
          nodes.push(node("surplus",3,shown("年度结余",payload.surplus,payload.incomeTotal),"#C5E5E2","right",{ decal:{ symbol:"rect", dashArrayX:[1,0], dashArrayY:[3,3], rotation:-0.65, color:"#4F9E99" } }));
        }
        if (narrow && !compact && mode === "combined") {
          nodes.forEach((item) => {
            if (item.name === "income-total") item.label = { position:"top", align:"right" };
            if (item.name === "expense-total") item.label = { position:"top", align:"left" };
          });
        }
        const chart = echarts.getInstanceByDom(element) || echarts.init(element, null, { renderer:"svg" });
        chart.setOption({ animation:false, tooltip:{ show:false }, series:[{ type:"sankey", orient:"horizontal", left:compact?72:(veryNarrow?66:narrow?78:145), right:compact?72:(veryNarrow?106:narrow?88:145), top:compact?32:(narrow?62:46), bottom:compact?32:(narrow?54:46), nodeWidth:compact?9:14, nodeGap:compact?10:(narrow?12:16), nodeAlign:"justify", draggable:false, layoutIterations:0, data:nodes, links, lineStyle:{ curveness:.5, opacity:.9 }, itemStyle:{ borderWidth:0, borderRadius:2 }, label:{ color:"#66717d", fontSize:compact?9:(veryNarrow?9:narrow?11:13), fontWeight:650, distance:compact?5:(veryNarrow?4:narrow?6:9), formatter:(params:{data?:{displayLabel?:string}})=>params.data?.displayLabel||"" }, emphasis:{ focus:"adjacency" } }] }, true);
        if (!chartObservers.has(element)) {
          const resizeObserver = new ResizeObserver(() => { if (!chart.isDisposed()) chart.resize(); });
          resizeObserver.observe(element); chartObservers.set(element, resizeObserver);
        }
        window.setTimeout(() => { if (!chart.isDisposed()) chart.resize(); }, 100);
      });
    };
    window.downloadSimpleCashflowChart = (filename = "年度现金流") => {
      const element = document.querySelector<HTMLElement>(".cf-share-image .cf-echart, .cf-sankey-stage .cf-echart");
      const chart = element ? echarts.getInstanceByDom(element) : undefined;
      if (!chart) return;
      const link = document.createElement("a");
      link.download = `${filename}.png`;
      link.href = chart.getDataURL({ type:"png", pixelRatio:2, backgroundColor:"#101010" });
      link.click();
    };
    window.mountSimpleCashflowCharts(window.getSimpleCashflowChartData?.() || { income:[], expenses:[], incomeTotal:0, expensesTotal:0, surplus:0 });
    const observer = new MutationObserver((mutations) => {
      const added = mutations.some((mutation) => Array.from(mutation.addedNodes).some((node) => node instanceof Element && (node.matches(".cf-echart") || !!node.querySelector(".cf-echart"))));
      if (added) requestAnimationFrame(() => window.mountSimpleCashflowCharts?.(window.getSimpleCashflowChartData?.() || { income:[], expenses:[], incomeTotal:0, expensesTotal:0, surplus:0 }));
    });
    observer.observe(document.body, { childList:true, subtree:true });
    return () => { observer.disconnect(); chartObservers.forEach((resizeObserver, element) => { resizeObserver.disconnect(); echarts.getInstanceByDom(element)?.dispose(); }); chartObservers.clear(); delete window.mountSimpleCashflowCharts; delete window.downloadSimpleCashflowChart; };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    let current = "";
    let stopped = false;
    const check = async () => {
      try {
        const response = await fetch("/api/simple-app/dev-version", { cache: "no-store" });
        const next = await response.text();
        if (stopped) return;
        if (current && next && next !== current) location.reload();
        current = next;
      } catch {}
    };
    void check();
    const timer = window.setInterval(check, 700);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const scroller = document.getElementById("app");
    if (!scroller) return;
    const isMobile = () => window.matchMedia("(max-width: 760px) and (pointer: coarse)").matches;
    const blocked = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : null;
      return !isMobile() || pullRef.current.refreshing ||
        Boolean(document.getElementById("mask")?.classList.contains("on")) ||
        Boolean(document.getElementById("skFull")?.classList.contains("on")) ||
        Boolean(element?.closest("input, textarea, select, [contenteditable='true'], .cf-sankey-stage, .sk-view"));
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1 || scroller.scrollTop > 0 || blocked(event.target)) return;
      const touch = event.touches[0];
      pullRef.current = { active: true, refreshing: false, startX: touch.clientX, startY: touch.clientY, distance: 0 };
    };
    const move = (event: TouchEvent) => {
      if (!pullRef.current.active || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const deltaX = touch.clientX - pullRef.current.startX;
      const deltaY = touch.clientY - pullRef.current.startY;
      if (deltaY <= 0 || Math.abs(deltaX) > deltaY || scroller.scrollTop > 0) {
        pullRef.current.active = false;
        setPullDistance(0);
        setPullState("idle");
        return;
      }
      if (deltaY < 6) return;
      event.preventDefault();
      const distance = Math.min(92, Math.round(deltaY * .48));
      pullRef.current.distance = distance;
      setPullDistance(distance);
      setPullState(distance >= 64 ? "ready" : "pulling");
    };
    const finish = async () => {
      if (!pullRef.current.active) return;
      pullRef.current.active = false;
      if (pullRef.current.distance < 64) {
        setPullDistance(0);
        setPullState("idle");
        return;
      }
      setPullDistance(50);
      setPullState("refreshing");
      pullRef.current.refreshing = true;
      const startedAt = Date.now();
      let ok = false;
      try { ok = await window.refreshSimpleApp?.() !== false; } catch { ok = false; }
      const remaining = Math.max(0, 520 - (Date.now() - startedAt));
      if (remaining) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      pullRef.current.refreshing = false;
      setPullState(ok ? "success" : "error");
      setPullDistance(42);
      window.setTimeout(() => {
        setPullDistance(0);
        setPullState("idle");
      }, 620);
    };
    const cancel = () => {
      pullRef.current.active = false;
      pullRef.current.distance = 0;
      setPullDistance(0);
      setPullState("idle");
    };
    scroller.addEventListener("touchstart", start, { passive: true });
    scroller.addEventListener("touchmove", move, { passive: false });
    scroller.addEventListener("touchend", finish, { passive: true });
    scroller.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      scroller.removeEventListener("touchstart", start);
      scroller.removeEventListener("touchmove", move);
      scroller.removeEventListener("touchend", finish);
      scroller.removeEventListener("touchcancel", cancel);
    };
  }, []);

  const pullLabel = pullState === "ready" ? "松开刷新" : pullState === "refreshing" ? "正在刷新" :
    pullState === "success" ? "已更新" : pullState === "error" ? "刷新失败" : "下拉刷新";
  const pullStyle = {
    "--pull-distance": `${pullDistance}px`,
    "--pull-opacity": Math.min(1, pullDistance / 28),
    "--pull-scale": Math.min(1, .86 + pullDistance / 650),
  } as React.CSSProperties;

  return (
    <>
      <div className="win" id="win">
        <div className="win-bar" id="winBar" title="按住拖动窗口">
          <TimeMachineMenu />
          <button type="button" id="pinBtn" title="固定窗口" aria-label="固定窗口" onClick={() => window.togglePin?.()}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4v5l3 3v2H7v-2l3-3V4"/><path d="M9 4h6"/><path d="M12 14v6"/></svg>
          </button>
          <button type="button" id="themeBtn" title="浅色 / 深色" aria-label="浅色深色切换" onClick={() => window.toggleTheme?.()}>
            <span className="th-wrap" aria-hidden="true">
              <svg className="th-sun" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/>
              </svg>
              <svg className="th-moon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
            </span>
          </button>
        </div>
        <div
          className={`simple-pull-indicator is-${pullState}`}
          style={pullStyle}
          role="status"
          aria-live="polite"
          aria-hidden={pullState === "idle"}
        >
          <span className="simple-pull-icon" aria-hidden="true">
            {pullState === "refreshing" ? <IconLoader2 size={16} stroke={2} /> : pullState === "success" ? <IconCheck size={16} stroke={2.2} /> : pullState === "error" ? <IconExclamationMark size={16} stroke={2.2} /> : <IconArrowDown size={16} stroke={2} />}
          </span>
          <span>{pullLabel}</span>
        </div>
        <div className="win-body" id="app" style={pullStyle} />
        <div className="dock" id="foot" />
        <div className="sk-full" id="skFull" />
        <div className="mask" id="mask" onClick={(event) => {
          if (event.target === event.currentTarget) window.closeMask?.();
        }} />
        {(["nw", "n", "ne", "e", "w", "sw", "s", "se"] as const).map((direction) => (
          <i className={`handle ${direction}`} data-dir={direction} key={direction} />
        ))}
      </div>
      <div className="toast" id="toast" />
      <Script
        src="/simple-app-runtime.js"
        strategy="afterInteractive"
        onReady={() => {
          window.remountSimpleApp?.();
        }}
      />
    </>
  );
}

declare global {
  interface Window {
    togglePin?: () => void;
    toggleTheme?: () => void;
    closeMask?: () => void;
    remountSimpleApp?: () => void;
    refreshSimpleApp?: () => Promise<boolean>;
    getSimpleCashflowChartData?: () => CashflowChartPayload;
    mountSimpleCashflowCharts?: (payload: CashflowChartPayload) => void;
    downloadSimpleCashflowChart?: (filename?: string) => void;
  }
}

type CashflowChartPayload = {
  income: Array<{ name:string; value:number }>;
  expenses: Array<{ name:string; value:number; type:string }>;
  incomeTotal:number;
  expensesTotal:number;
  surplus:number;
};
