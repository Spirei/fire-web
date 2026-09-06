"use client";

import Script from "next/script";
import { useEffect, useLayoutEffect } from "react";
import echarts from "@/lib/echarts";

const WINDOW_KEY = "fire-simple-win";

export default function SimpleAppClient() {
  useLayoutEffect(() => {
    try {
      document.documentElement.classList.toggle("dark", localStorage.getItem("fire-simple-theme") === "dark");
      const saved = JSON.parse(localStorage.getItem(WINDOW_KEY) || "null") as { w?: number } | null;
      if (saved && Number.isFinite(saved.w)) {
        document.documentElement.style.setProperty("--saved-win-w", `${Math.max(360, saved.w!)}px`);
      }
    } catch {}
  }, []);

  useEffect(() => {
    window.mountSimpleCashflowCharts = (payload) => {
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
        new ResizeObserver(() => chart.resize()).observe(element);
        window.setTimeout(() => chart.resize(), 100);
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
    return () => { observer.disconnect(); delete window.mountSimpleCashflowCharts; delete window.downloadSimpleCashflowChart; };
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

  return (
    <>
      <div className="win" id="win">
        <div className="win-bar" id="winBar" title="按住拖动窗口">
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
        <div className="win-body" id="app" />
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
          if (!document.getElementById("app")?.childElementCount) window.remountSimpleApp?.();
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
