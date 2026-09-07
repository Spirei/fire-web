// 在首帧绘制前恢复窗口宽度，避免先按默认 600px 渲染后再向右扩张。
    try {
      const savedWin = JSON.parse(localStorage.getItem("fire-simple-win") || "null");
      const viewportW = window.innerWidth || document.documentElement.clientWidth;
      const viewportChanged = savedWin && (savedWin.layoutVersion !== 3 || !Number.isFinite(savedWin.vw) || Math.abs(savedWin.vw - viewportW) > 48);
      const restoredW = viewportChanged && viewportW >= 1100
        ? Math.min(1040, viewportW - 64)
        : Math.min(Math.max(360, Number(savedWin?.w) || 680), Math.max(360, viewportW - 16));
      document.documentElement.style.setProperty("--saved-win-w", restoredW + "px");
    } catch {}

const KEY = "fire-simple-book-v3";
const KEY_OLD = "fire-simple-book-v2";
const PAGE_W = {
  home: 680, weather: 680, cashflow: 680, family: 740, calendar: 720, manage: 740,
  update: 740, addItem: 600, editItem: 640, help: 640, invest: 420, addInvest: 600,
  summary: 560, addSummary: 520, account: 560, settings: 520
};
const EMPTY = {
  hide: false, excludeFixed: false, displayCur: "CNY",
  fx: { CNY: 1, HKD: 0.92, USD: 7.18 },
  reminder: 0, expected: 8,
  cash: [], fixed: [], receivable: [], debt: [], invest: [],
  cashflow: { schemaVersion: 5, started: false, completed: false, incomeItems: [], expenseItems: [] }, summaries: [],
  snaps: [], logs: [],
  members: [{ id: "me", name: "我" }]
};
const CATS = [
  { id: "cash", label: "流动资金", hint: "随时可取用的现金、活期、余额宝等" },
  { id: "fixed", label: "固定资产", hint: "房产、车辆等变现较慢的资产" },
  { id: "invest", label: "投资理财", hint: "股票、基金、理财账户的当前市值" },
  { id: "receivable", label: "应收款", hint: "别人欠你、押金、待退款" },
  { id: "debt", label: "负债", hint: "房贷、信用卡、花呗等需要偿还的钱" }
];
const EXAMPLES = {
  cash: ["支付宝微信", "银行卡", "现金", "汇丰(港币)"],
  fixed: ["房产", "车辆", "其他"],
  receivable: ["他人借款", "押金", "待退款"],
  debt: ["房贷", "信用卡", "花呗", "借呗"],
  invest: ["长钱账户", "余额宝", "固收+组合", "雪球组合", "招商银行理财", "券商账户", "海外资产"]
};
const CURS = [
  { code: "CNY", name: "人民币", unit: "元" },
  { code: "HKD", name: "港元", unit: "港元" },
  { code: "USD", name: "美元", unit: "美元" }
];
function currencyUnit(code) {
  return (CURS.find((item) => item.code === code) || CURS[0]).unit;
}
const MARKETS = [
  { id: "US", label: "美股", cur: "USD" },
  { id: "HK", label: "港股", cur: "HKD" },
  { id: "CN", label: "A股", cur: "CNY" },
  { id: "JP", label: "日股", cur: "CNY" },
  { id: "KR", label: "韩股", cur: "CNY" },
  { id: "SG", label: "新加坡", cur: "CNY" },
  { id: "UK", label: "英国", cur: "CNY" },
  { id: "DE", label: "德国", cur: "CNY" },
  { id: "FR", label: "法国", cur: "CNY" },
  { id: "AU", label: "澳大利亚", cur: "CNY" },
  { id: "CA", label: "加拿大", cur: "CNY" },
  { id: "IN", label: "印度", cur: "CNY" },
  { id: "TW", label: "中国台湾", cur: "CNY" },
  { id: "BR", label: "巴西", cur: "CNY" }
];
const INV_FILTERS = ["全部资产", "活钱", "稳健", "长期"];
const SIMPLE_BENCHMARKS = [
  { key:"spy", label:"标普 500", market:"US", code:"SPY" },
  { key:"qqq", label:"纳斯达克", market:"US", code:"QQQ" },
  { key:"dia", label:"道琼斯", market:"US", code:"DIA" },
  { key:"hsi", label:"恒生指数", market:"HK", code:"02800", index:true },
  { key:"sse", label:"上证指数", market:"CN", code:"sh000001", index:true }
];
let marketIcons = {};

let S = load();
let route = { name: "home", cat: "cash", member: "全部", chartKind: "mwr", chartRange: "all", showAll: false, showArchived: false, investSort: "updated", sortMenu: false, impMenu: false, editFlow: false, groupMenu: null, accMenu: false };
let updateTarget = null;
let saveTimer = 0;
let loggedIn = false;
const PAGES = ["home","weather","cashflow","family","calendar","manage","update","addItem","editItem","help","invest","addInvest","summary","addSummary","account","settings"];
const RAINBOW = ["#ff5f6d","#ff8a4c","#ffb84d","#b58aff","#8077ff","#4ca9f5","#37c7da","#2bc9a5"];
let urlLock = false;
let benchState = { key: localStorage.getItem("fire:asset-benchmark") || "spy", loadedKey:"", items:[], loading:false, error:"" };

function uid() { return "x" + Math.random().toString(36).slice(2, 8); }
function pad(n) { return String(n).padStart(2, "0"); }
function iso(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return iso(new Date());
  return x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
}
function today() { return iso(new Date()); }
function pretty(s) {
  if (!s) return "";
  const p = String(s).slice(0, 10).split("-");
  if (p.length < 3) return s;
  return p[0] + "." + p[1] + "." + p[2];
}
function md(s) {
  const p = String(s || "").slice(0, 10).split("-");
  if (p.length < 3) return s || "";
  return Number(p[1]) + "月" + Number(p[2]) + "日";
}
function zhDate(s) {
  const p = String(s || "").slice(0, 10).split("-");
  if (p.length < 3) return s || "";
  return p[0] + "年" + Number(p[1]) + "月" + Number(p[2]) + "日";
}
function parseDay(s) {
  const t = Date.parse(String(s || "").slice(0, 10));
  return Number.isFinite(t) ? t : 0;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;", "`": "&#96;" }[c]));
}
function canonicalFlows(a) {
  const hist = (Array.isArray(a.hist) ? a.hist : []).slice().sort((x, y) => String(x.d).localeCompare(String(y.d)));
  if (!hist.length) return { inAmt: Number(a.inAmt) || 0, outAmt: Number(a.outAmt) || 0 };
  const first = hist[0];
  const opening = Math.max(0, (Number(first.v) || 0) - (Number(first.inn) || 0) + (Number(first.out) || 0));
  return {
    inAmt: opening + hist.reduce((n, h) => n + (Number(h.inn) || 0), 0),
    outAmt: hist.reduce((n, h) => n + (Number(h.out) || 0), 0)
  };
}
function cleanImportedHist(hist) {
  const rows = (Array.isArray(hist) ? hist : []).slice().sort((x, y) => String(x.d).localeCompare(String(y.d)));
  const kept = rows.filter((h, i) => {
    if (!i || rows.length < 2) return true;
    const prev = rows[i - 1];
    const v = Number(h.v) || 0, inn = Number(h.inn) || 0, out = Number(h.out) || 0;
    // 旧版先建空账户再导入时，会在真实历史之后残留一条「金额=投入=上一期资产」的种子记录。
    return !(out === 0 && Math.abs(inn - v) < .000001 && Math.abs((Number(prev.v) || 0) - v) < .000001);
  });
  // 旧版在只有转入转出、没有同日总资产的日期沿用了上一期市值，制造出虚假的曲线尖峰。
  // 资金流本身不产生收益，这类点应先按净流入同步调整市值。
  return kept.map((h, i) => {
    if (!i) return h;
    const prev = kept[i - 1], flow = (Number(h.inn) || 0) - (Number(h.out) || 0);
    const v = Number(h.v) || 0, prevV = Number(prev.v) || 0;
    const unchanged = Math.abs(v - prevV) < .000001;
    // 早期导入器会把「仅转入转出」行的现金流金额误当成总资产，表现为
    // 入金 5,000 当天资产突然变成 5,000。此类旧数据按上一笔资产加净现金流还原。
    const legacyFlowOnly = (Math.abs(v) < .000001 || Math.abs(v - Math.abs(flow)) < .000001) && Math.abs(prevV) > Math.abs(flow);
    if (flow && (unchanged || legacyFlowOnly)) return { ...h, v: prevV + flow };
    return h;
  });
}
function normalize(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const savedCf = p.cashflow && Number(p.cashflow.schemaVersion) === 5 ? p.cashflow : {};
  const next = { ...EMPTY, ...p, fx: { ...EMPTY.fx, ...(p.fx || {}) }, cashflow: { ...EMPTY.cashflow, ...savedCf } };
  const cf = next.cashflow;
  cf.incomeItems = Array.isArray(cf.incomeItems) ? cf.incomeItems : [];
  cf.expenseItems = Array.isArray(cf.expenseItems) ? cf.expenseItems : [];
  for (const k of ["cash", "fixed", "receivable", "debt", "invest", "snaps", "logs", "members", "summaries"]) next[k] = Array.isArray(p[k]) ? p[k] : [];
  if (!next.members.length) next.members = [{ id: "me", name: "我" }];
  next.invest = next.invest.map((a) => {
    const hist = cleanImportedHist(a.hist);
    const clean = { ...a, hist };
    const fixed = a.flowAdjusted ? { inAmt: Number(a.inAmt) || 0, outAmt: Number(a.outAmt) || 0 } : canonicalFlows(clean);
    const last = hist[hist.length - 1];
    return { bucket: a.bucket || "长期", market: a.market || "", ...clean, ...fixed,
      amount: last && last.v != null ? Number(last.v) || 0 : Number(a.amount) || 0,
      updated: last ? String(last.d).slice(0, 10) : a.updated };
  });
  return next;
}
function isEmptyBook(b) {
  return !b.cash.length && !b.fixed.length && !b.receivable.length && !b.debt.length && !b.invest.length;
}
function load() {
  try {
    const v3 = localStorage.getItem(KEY);
    if (v3) return normalize(JSON.parse(v3));
    const v2 = localStorage.getItem(KEY_OLD);
    if (v2) return normalize(JSON.parse(v2));
  } catch {}
  return normalize(null);
}
function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }
function save() {
  saveLocal();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushRemote, 450);
}
function bookEmpty(b) { return isEmptyBook(b || S); }
async function hydrate() {
  try {
    const r = await fetch("/api/v1/simple-ledger", { credentials: "same-origin" });
    if (!r.ok) return;
    loggedIn = true;
    const j = await r.json();
    const remote = normalize(j.data || j);
    // 登录用户以服务端数据为准，避免共享浏览器上的本地缓存串入其他账号。
    S = remote;
    saveLocal();
    render({ skipUrl: true });
    restoreDlg();
    pullRates();
  } catch {}
}
async function pushRemote() {
  if (!loggedIn) {
    try {
      const r = await fetch("/api/v1/simple-ledger", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(S) });
      loggedIn = r.ok;
    } catch {}
    return;
  }
  try {
    await fetch("/api/v1/simple-ledger", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(S) });
  } catch {}
}
async function pullRates() {
  try {
    const r = await fetch("/api/rates", { credentials: "same-origin" });
    if (!r.ok) return;
    const j = await r.json();
    const rates = j.rates || {};
    if (!rates.CNY) return;
    S.fx.CNY = 1;
    S.fx.USD = rates.CNY;
    if (rates.HKD) S.fx.HKD = rates.CNY / rates.HKD;
    saveLocal();
  } catch {}
}
function fxRate(cur) { return (S.fx && S.fx[cur]) || 1; }
function cny(item) { return (Number(item.amount) || 0) * fxRate(item.cur); }
function sum(list) { return (list || []).reduce((n, x) => n + cny(x), 0); }
function money(n, cur) {
  if (S.hide) return "****";
  const abs = Math.abs(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? "-" : "";
  if (cur === "USD") return sign + "$ " + abs;
  if (cur === "HKD") return sign + "HK$ " + abs;
  return sign + "¥ " + abs;
}
function num(n, d) {
  if (S.hide) return "****";
  return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
}
function pct(n) {
  if (n == null || Number.isNaN(n)) return "暂无";
  if (S.hide) return "****";
  const v = Number(n);
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}
function tone(n) { return !n ? "faint" : n > 0 ? "red" : "green"; }
function signed(n, cur) {
  if (S.hide) return "****";
  const prefix = n > 0 ? "+" : "";
  return prefix + money(n, cur);
}
function signedNum(n) {
  if (S.hide) return "****";
  const prefix = n > 0 ? "+" : "";
  return prefix + num(n);
}
function compactNum(n, d = 2) {
  if (S.hide) return "****";
  const value = Number(n) || 0;
  const abs = Math.abs(value);
  const units = [[1e12, "万亿"], [1e8, "亿"], [1e4, "万"]];
  const unit = units.find(([base]) => abs >= base);
  if (!unit) return num(value, d);
  const shown = (value / unit[0]).toFixed(d).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
  return shown + unit[1];
}
function compactSignedNum(n, d = 2) {
  if (S.hide) return "****";
  return (Number(n) > 0 ? "+" : "") + compactNum(n, d);
}
function toast(t) {
  const n = document.getElementById("toast");
  n.textContent = t;
  n.classList.add("on");
  setTimeout(() => n.classList.remove("on"), 1500);
}
function routeQuery() {
  const q = new URLSearchParams();
  if (route.name && route.name !== "home") q.set("page", route.name);
  if (route.cat && (route.name === "update" || route.name === "addItem" || route.name === "editItem" || route.name === "help")) q.set("cat", route.cat);
  if (route.member && route.member !== "全部") q.set("member", route.member);
  if (route.account && (route.name === "account" || route.name === "settings" || route.dlg === "update")) q.set("account", route.account);
  if (route.itemId && route.name === "editItem") q.set("item", route.itemId);
  // 图表种类/范围属个人偏好 → localStorage，不再写入地址栏，避免 URL 过长
  if (route.invFilter && route.invFilter !== "全部资产" && route.name === "invest") q.set("filter", route.invFilter);
  if (route.trendMode && route.trendMode !== "all" && route.name === "family") q.set("trend", route.trendMode);
  if (route.trendRange && route.trendRange !== "all" && route.name === "family") q.set("trange", route.trendRange);
  if (route.dlg) q.set("dlg", route.dlg);
  if (route.dlg === "update" && (updateTarget || route.dlgTarget)) q.set("target", updateTarget || route.dlgTarget);
  return q;
}
function syncUrl(push) {
  if (urlLock) return;
  const qs = routeQuery().toString();
  const next = location.pathname + (qs ? "?" + qs : "");
  const cur = location.pathname + location.search;
  if (next === cur) return;
  history[push ? "pushState" : "replaceState"]({ name: route.name }, "", next);
}
function readUrl(search) {
  const q = new URLSearchParams(search || location.search);
  const page = q.get("page");
  if (PAGES.includes(page)) route.name = page;
  const cat = q.get("cat");
  if (cat && CATS.some((c) => c.id === cat)) route.cat = cat;
  const member = q.get("member");
  if (member) route.member = member;
  const account = q.get("account");
  if (account) route.account = account;
  const item = q.get("item");
  if (item) route.itemId = item;
  try { const _k = localStorage.getItem("fire:chart-kind"); if (_k === "mwr" || _k === "pnl") route.chartKind = _k; } catch {}
  try { route.chartRange = localStorage.getItem("fire:chart-range") || "all"; } catch {}
  const filter = q.get("filter");
  if (filter) route.invFilter = filter;
  const trend = q.get("trend");
  if (trend === "all" || trend === "net") route.trendMode = trend;
  const trange = q.get("trange");
  if (trange) route.trendRange = trange;
  route.dlg = q.get("dlg") || null;
  route.dlgTarget = q.get("target") || account || null;
  if (route.dlg === "update") updateTarget = route.dlgTarget;
  // 清理旧版写入地址栏的图表参数（chart / range），保持 URL 简洁
  if (/[?&](chart|range)=/.test(location.search)) { const qs = routeQuery().toString(); history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "")); }
}
function setChartKind(k) {
  if (k !== "mwr" && k !== "pnl") return;
  route.chartKind = k; route.benchOpen = false;
  try { localStorage.setItem("fire:chart-kind", k); } catch {}
  render({ resize: false, keepScroll: true });
}
function setChartRange(r) { route.chartRange = r; try { localStorage.setItem("fire:chart-range", r); } catch {} render({ resize: false }); }
function benchMeta() { return SIMPLE_BENCHMARKS.find((x) => x.key === benchState.key) || SIMPLE_BENCHMARKS[0]; }
async function ensureBenchmark(force) {
  const b = benchMeta();
  if (benchState.loading || (!force && benchState.loadedKey === b.key)) return;
  benchState.loading = true; benchState.error = "";
  try {
    const url = `/api/kline/full?market=${encodeURIComponent(b.market)}&code=${encodeURIComponent(b.code)}&limit=1600${b.index ? "&index=1" : ""}`;
    const res = await fetch(url, { cache:"no-store" });
    if (!res.ok) throw new Error("benchmark");
    const data = await res.json();
    const items = (Array.isArray(data.items) ? data.items : []).map((x) => ({ d:String(x.d || "").slice(0,10), c:Number(x.c) })).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d) && Number.isFinite(x.c) && x.c > 0).sort((a,b) => a.d.localeCompare(b.d));
    if (!items.length) throw new Error("empty");
    benchState.items = items; benchState.loadedKey = b.key;
  } catch { benchState.error = "指数行情暂时不可用"; benchState.loadedKey = b.key; }
  benchState.loading = false;
  if (["account","summary"].includes(route.name)) render({ resize:false, keepScroll:true });
}
function pickBenchmark(key) {
  if (!SIMPLE_BENCHMARKS.some((x) => x.key === key)) return;
  benchState.key = key; benchState.items = []; benchState.loadedKey = ""; route.benchOpen = false; route.yearBenchOpen = false;
  try { localStorage.setItem("fire:asset-benchmark", key); } catch {}
  render({ resize:false, keepScroll:true }); ensureBenchmark(true);
}
let trendHoverModel = null;
let trendHoverFrame = 0, trendHoverPending = null;
function moveTrendHover(event, svg) {
  trendHoverPending = { clientX:event.clientX, svg };
  if (trendHoverFrame) return;
  trendHoverFrame = requestAnimationFrame(() => {
    trendHoverFrame = 0;
    const pending = trendHoverPending; trendHoverPending = null;
    if (pending) paintTrendHover(pending.clientX, pending.svg);
  });
}
function paintTrendHover(clientX, svg) {
  const m = trendHoverModel;
  if (!m || !m.main.length) return;
  const cache = svg._trendHover || (svg._trendHover = {
    rect:svg.getBoundingClientRect(),
    line:svg.querySelector('[data-hover-line]'), dot:svg.querySelector('[data-hover-main]'),
    bdot:svg.querySelector('[data-hover-bench]'), tip:svg.parentElement.querySelector('.trend-hover-tip'),
    date:svg.parentElement.querySelector('[data-tip-date]'), mainValue:svg.parentElement.querySelector('[data-tip-main-value]'),
    benchValue:svg.parentElement.querySelector('[data-tip-bench-value]'), index:-1
  });
  const rect = cache.rect;
  const vx = (clientX - rect.left) * 360 / Math.max(rect.width, 1);
  const i = Math.max(0, Math.min(m.main.length - 1, Math.round((vx - 18) / 316 * Math.max(m.main.length - 1, 1))));
  if (i === cache.index) return;
  cache.index = i;
  const x = m.xAt(i, m.main.length), y = m.yAt(m.main[i]);
  const line = cache.line, dot = cache.dot;
  line.setAttribute('x1', x); line.setAttribute('x2', x); line.style.display = '';
  dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.style.display = '';
  const bi = m.bench.length ? Math.max(0, Math.min(m.bench.length - 1, Math.round(i / Math.max(m.main.length - 1, 1) * Math.max(m.bench.length - 1, 1)))) : -1;
  const bdot = cache.bdot;
  if (bi >= 0) { bdot.setAttribute('cx', m.xAt(bi, m.bench.length)); bdot.setAttribute('cy', m.yAt(m.bench[bi])); bdot.style.display = ''; } else bdot.style.display = 'none';
  const tip = cache.tip;
  const mainValue = m.kind === 'pnl' ? num(m.main[i]) + ' ' + m.unit : pct(m.main[i]);
  cache.date.textContent = m.dates[i] || '';
  cache.mainValue.textContent = mainValue;
  if (cache.benchValue && bi >= 0) cache.benchValue.textContent = pct(m.bench[bi]);
  const px = x / 360 * rect.width;
  tip.style.setProperty('--tip-x', Math.max(6, Math.min(rect.width - 150, px + (px > rect.width * .58 ? -148 : 10))) + 'px');
  tip.classList.add('on');
}
function leaveTrendHover(svg) {
  if (trendHoverPending && trendHoverPending.svg === svg) trendHoverPending = null;
  const cache = svg._trendHover;
  if (cache) {
    cache.index = -1;
    [cache.line,cache.dot,cache.bdot].forEach((x) => x.style.display = 'none');
    cache.tip.classList.remove('on');
  }
}
function go(name, extra) {
  const prev = route.name;
  const freshEntry = (name === "addItem" || name === "addInvest") && prev !== name;
  route = { ...route, name, menu: false, invMenu: false, sortMenu: false, impMenu: false, editFlow: false, groupMenu: null, accMenu: false, showAll: false, ...(name === "invest" ? {} : { showArchived: false }), ...(freshEntry ? { draft: null, more: false } : {}), dlg: null, dlgTarget: null, ...(extra || {}) };
  closeSankey();
  closeDrop();
  closeMask({ silent: true });
  render({ resize: false, pushUrl: prev !== route.name });
}
function chevLeft() {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`;
}
function topBar(back, right) {
  return `<div class="bar">
    <button class="back" type="button" onclick="${back}" aria-label="返回">${chevLeft()}</button>
    ${right ? `<div class="right">${right}</div>` : ""}
  </div>`;
}
function navHead(back, title, right) {
  return `<div class="head center">
    <button class="back" type="button" onclick="${back}" aria-label="返回">${chevLeft()}</button>
    <h1>${title}</h1>
    <div class="right">${right || ""}</div>
  </div>`;
}
function marketLabel(id) {
  const m = MARKETS.find((x) => x.id === id);
  return m ? m.label : (id || "未选市场");
}
function marketCur(id) {
  const m = MARKETS.find((x) => x.id === id);
  return m ? m.cur : "CNY";
}
// 账本关键词 → 分组名（市场 + （关键词）），导入 xlsx / json 时按正则匹配账户名（可再加文件名兜底）
const LEDGER_RULES = [
  { re: /长桥|long[ -]?bridge/i, key: "长桥" },
  { re: /富途|moomoo|\bfutu\b/i, key: "富途" },
  { re: /ibkr|盈透|interactive\s*brokers?/i, key: "IBKR" },
  { re: /老虎|\btiger\b/i, key: "老虎" },
  { re: /雪盈|snowball/i, key: "雪盈" },
  { re: /微牛|webull/i, key: "微牛" },
  { re: /嘉信|schwab/i, key: "嘉信" },
  { re: /第一证券|firstrade/i, key: "第一证券" },
  { re: /德美利|ameritrade/i, key: "德美利" },
  { re: /华泰|huatai/i, key: "华泰" },
  { re: /中信|citics/i, key: "中信" },
  { re: /招商银行|招商证券|\bcmb\b/i, key: "招商" },
  { re: /国泰君安|guotai/i, key: "国泰君安" },
  { re: /银河|galaxy/i, key: "银河" },
  { re: /广发|\bgf\b/i, key: "广发" },
  { re: /东方财富|东财|eastmoney/i, key: "东方财富" },
  { re: /雪球|xueqiu/i, key: "雪球" },
  { re: /且慢|qieman/i, key: "且慢" },
  { re: /蛋卷|danjuan/i, key: "蛋卷" },
  { re: /天天基金|ttjj/i, key: "天天基金" },
  { re: /蚂蚁|支付宝|alipay/i, key: "蚂蚁" },
  { re: /币安|binance/i, key: "币安" },
  { re: /欧易|\bokx\b/i, key: "OKX" },
  { re: /火币|huobi/i, key: "火币" },
  { re: /港a|港股通|hkconnect/i, key: "港A" }
];
function ledgerKeyFromName(s) {
  const t = String(s || "");
  for (const r of LEDGER_RULES) if (r.re.test(t)) return r.key;
  return "";
}
function ledgerGroup(name, market, fileName) {
  let key = ledgerKeyFromName(name);
  if (!key && fileName) key = ledgerKeyFromName(fileName);
  if (!key) return "";
  const m = marketLabel(market || "");
  return (m && m !== "未选市场" ? m + "（" + key + "）" : key);
}
function applyLedgerRules(fileName) {
  let changed = false;
  for (const a of S.invest) {
    if (!a || a.group) continue;
    const g = ledgerGroup(a.name, a.market, fileName);
    if (g) { a.group = g; changed = true; }
  }
  return changed;
}
function globeSvg(size) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.45 3.6 5.45 3.6 9S14.4 18.55 12 21c-2.4-2.45-3.6-5.45-3.6-9S9.6 5.45 12 3Z"/></svg>`;
}
function marketIco(code, size) {
  size = size || 18;
  const id = String(code || "").toUpperCase();
  const flagCode = id === "UK" ? "gb" : id.toLowerCase();
  const localFlag = /^[a-z]{2}$/.test(flagCode) ? `/uploads/asset/flag/${flagCode}.svg` : "";
  const src = (id && marketIcons[id]) || localFlag;
  const hide = src ? "display:none;" : "";
  const fb = `<span class="mkt-fb" style="${hide}width:${size}px;height:${size}px">${globeSvg(Math.max(10, Math.round(size * 0.62)))}</span>`;
  if (!src) return fb;
  return `<img class="mkt-ico" src="${esc(src)}" width="${size}" height="${size}" alt="" onerror="this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='inline-flex'" />${fb}`;
}
function ingestMarketIcons(list) {
  const next = {};
  (list || []).forEach((a) => {
    if (a && a.type && a.type !== "flag") return;
    const code = String(a.code || "").toUpperCase();
    if (code && a.url) next[code] = a.url;
  });
  marketIcons = next;
}
function loadMarketIcons() {
  try {
    const raw = localStorage.getItem("fire:assets:cache:flag");
    if (raw) {
      const parsed = JSON.parse(raw);
      ingestMarketIcons(Array.isArray(parsed) ? parsed : parsed.assets);
    }
  } catch {}
  fetch("/api/assets?type=flag", { credentials: "same-origin" })
    .then((r) => r.ok ? r.json() : null)
    .then((j) => {
      if (!j || !Array.isArray(j.assets)) return;
      ingestMarketIcons(j.assets);
      try { localStorage.setItem("fire:assets:cache:flag", JSON.stringify({ assets: j.assets, at: Date.now(), version: 1 })); } catch {}
      if (["invest", "addInvest", "account", "settings"].includes(route.name)) render({ resize: false, keepScroll: true, skipUrl: true });
    })
    .catch(() => {});
}
function closeDrop() {
  document.querySelectorAll(".dd-menu").forEach((el) => { el.hidden = true; });
  document.querySelectorAll(".dd-btn[aria-expanded]").forEach((el) => el.setAttribute("aria-expanded", "false"));
}
function toggleDrop(id, ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById(id);
  if (!menu) return;
  const open = menu.hidden;
  closeDrop();
  if (open) {
    menu.hidden = false;
    menu.classList.remove("up");
    const btn = menu.previousElementSibling;
    if (btn && btn.classList.contains("dd-btn")) btn.setAttribute("aria-expanded", "true");
    const box = menu.getBoundingClientRect();
    const win = document.getElementById("win");
    const wr = win ? win.getBoundingClientRect() : { bottom: window.innerHeight };
    if (box.bottom > wr.bottom - 10) menu.classList.add("up");
  }
}
function setInvFilter(v) {
  route.invFilter = v;
  closeDrop();
  render({ resize: false });
}
function filteredInvest() {
  const f = route.invFilter || "全部资产";
  const rows = S.invest.filter((a) => route.showArchived ? a.archived : !a.archived);
  const filtered = (!f || f === "全部资产" || f === "全部") ? rows : rows.filter((a) => a.bucket === f);
  if (route.sorting) return filtered;
  const sort = route.investSort || "updated";
  return filtered.slice().sort((a, b) => sort === "amount" ? Number(b.amount || 0) - Number(a.amount || 0) : sort === "name" ? String(a.name || "").localeCompare(String(b.name || ""), "zh") : String(b.updated || "").localeCompare(String(a.updated || "")));
}
function investGroups(list) {
  const map = new Map();
  for (const a of list || []) {
    const label = a.group || (a.market ? marketLabel(a.market) : "未分组");
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(a);
  }
  return [...map.entries()].map(([label, items]) => ({ label, items }));
}
function invFilterSelect() {
  const cur = route.invFilter || "全部资产";
  return `<div class="dd">
    <button type="button" class="dd-btn" aria-expanded="false" onclick="toggleDrop('invFilterMenu',event)">
      <b>${esc(cur)}</b>
      <svg class="dd-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="dd-menu" id="invFilterMenu" hidden>
      ${INV_FILTERS.map((f) => `<button type="button" class="dd-item ${cur === f ? "on" : ""}" onclick="setInvFilter('${f}')">${esc(f)}${cur === f ? `<span class="tick">✓</span>` : ""}</button>`).join("")}
    </div>
  </div>`;
}
function marketSelect(id, value, fnName, extra) {
  const cur = MARKETS.find((m) => m.id === value) || null;
  return `<div class="dd">
    <button type="button" class="dd-btn block" aria-expanded="false" onclick="toggleDrop('${id}',event)">
      ${cur ? marketIco(cur.id, 20) : `<span class="mkt-fb" style="width:20px;height:20px">${globeSvg(12)}</span>`}
      <span>${cur ? esc(cur.label) : "选择市场"}</span>
      <svg class="dd-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="dd-menu wide" id="${id}" hidden>
      ${MARKETS.map((m) => {
        const call = extra ? `${fnName}('${extra}','${m.id}')` : `${fnName}('${m.id}')`;
        return `<button type="button" class="dd-item ${value === m.id ? "on" : ""}" onclick="${call}">${marketIco(m.id, 20)}<span>${esc(m.label)}</span>${value === m.id ? `<span class="tick">✓</span>` : ""}</button>`;
      }).join("")}
    </div>
  </div>`;
}
function pickDraftMarket(id) {
  route.draft = { name: "", amount: "", bucket: "长期", cur: marketCur(id), expected: S.expected, market: "CN", ...(route.draft || {}), market: id, cur: marketCur(id) };
  render();
}
function pickInvestMarket(assetId, market) {
  patchInvest(assetId, { market });
}
function weatherSvg() {
  return `<svg class="wx-ico" viewBox="0 0 24 18" aria-hidden="true">
    <circle cx="16.5" cy="7" r="4.2" fill="#f6c453"/>
    <path d="M6.2 16.2c-2.2 0-3.9-1.6-3.9-3.5 0-1.7 1.3-3.2 3.1-3.5.4-1.8 2-3.2 4-3.2 1.6 0 3 .8 3.7 2 .6-.3 1.3-.4 2-.4 2.3 0 4.1 1.7 4.1 3.8 0 2.1-1.8 3.8-4.1 3.8H6.2z" fill="#f3f6f2" stroke="#d7e3cf" stroke-width=".6"/>
  </svg>`;
}
function currentOwner() {
  if (route.member && route.member !== "全部") return route.member;
  const me = memberList().find((m) => m.id === "me") || memberList()[0];
  return me ? me.name : "我";
}
function hideBtn() {
  const icon = S.hide
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 3l18 18M10.6 10.6A3 3 0 0 0 13.4 13.4M9.9 5.1A10 10 0 0 1 12 5c5 0 9.3 3.1 11 7.5a11.7 11.7 0 0 1-4.2 4.8M6.1 6.1A11.7 11.7 0 0 0 1 12.5 10.8 10.8 0 0 0 12 19c1.1 0 2.2-.2 3.2-.5"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
  return `<button class="eye" type="button" onclick="S.hide=!S.hide;save();render({resize:false,keepScroll:true})" aria-label="显示或隐藏金额">${icon}</button>`;
}
function listByCat(cat) { return cat === "invest" ? S.invest : (S[cat] || []); }
function investPnl(a) { return (Number(a.amount) || 0) - ((Number(a.inAmt) || 0) - (Number(a.outAmt) || 0)); }
function histPerformance(hist) {
  const rows = (hist || []).slice().sort((a, b) => String(a.d).localeCompare(String(b.d)));
  if (!rows.length) return { mwr: null, annual: null };
  const first = rows[0], last = rows[rows.length - 1];
  const start = Number(first.v) || 0, end = Number(last.v) || 0;
  const t0 = parseDay(first.d), t1 = parseDay(last.d), span = Math.max(0, t1 - t0);
  let netFlow = 0, weightedFlow = 0;
  for (let i = 1; i < rows.length; i++) {
    const flow = (Number(rows[i].inn) || 0) - (Number(rows[i].out) || 0);
    netFlow += flow;
    if (span) weightedFlow += flow * Math.max(0, t1 - parseDay(rows[i].d)) / span;
  }
  const profit = end - start - netFlow;
  const denominator = start + weightedFlow;
  const mwr = denominator ? profit / denominator * 100 : null;

  // 年化收益率使用与有知有行一致的 XIRR：首日资产视为初始投入，
  // 后续转入为负现金流、转出为正现金流，最后加回期末资产。
  let annual = null;
  if (span >= 7 * 86400000 && start > 0 && end >= 0) {
    const cash = [{ t: t0, v: -start }];
    for (let i = 1; i < rows.length; i++) {
      const v = -(Number(rows[i].inn) || 0) + (Number(rows[i].out) || 0);
      if (v) cash.push({ t: parseDay(rows[i].d), v });
    }
    cash.push({ t: t1, v: end });
    const npv = (rate) => cash.reduce((sum, x) => sum + x.v / Math.pow(1 + rate, (x.t - t0) / 31536000000), 0);
    let lo = -.9999, hi = 10;
    if (npv(lo) * npv(hi) <= 0) {
      for (let i = 0; i < 120; i++) { const mid = (lo + hi) / 2; if (npv(mid) > 0) lo = mid; else hi = mid; }
      annual = (lo + hi) / 2 * 100;
    }
  }
  return { mwr, annual };
}
function investStats(a) {
  const inAmt = Number(a.inAmt) || 0;
  const outAmt = Number(a.outAmt) || 0;
  const net = inAmt - outAmt;
  const pnl = (Number(a.amount) || 0) - net;
  const hist = (a.hist || []).slice().sort((x, y) => String(x.d).localeCompare(String(y.d)));
  const first = hist[0] ? String(hist[0].d).slice(0, 10) : "";
  const last = hist.length ? String(hist[hist.length - 1].d).slice(0, 10) : String(a.updated || "").slice(0, 10);
  const perf = histPerformance(hist);
  const mwr = perf.mwr != null ? perf.mwr : (net > 0 ? (pnl / net) * 100 : null);
  const ytd = perf.annual;
  return { inAmt, outAmt, net, pnl, mwr, ytd, first, last, hist };
}
function yearMwr(hist, year) {
  const pts = (hist || []).filter((h) => String(h.d).slice(0, 4) === String(year)).sort((a, b) => String(a.d).localeCompare(String(b.d)));
  const before = (hist || []).filter((h) => String(h.d).slice(0, 4) < String(year)).sort((a, b) => String(a.d).localeCompare(String(b.d)));
  if (!pts.length) return null;
  const rows = before.length
    ? [{ d: `${year}-01-01`, v: Number(before[before.length - 1].v) || 0, inn: 0, out: 0 }, ...pts]
    : pts;
  return histPerformance(rows).mwr;
}
function thisYearNetIn() {
  const y = String(new Date().getFullYear());
  let n = 0;
  for (const a of S.invest) {
    for (const h of a.hist || []) {
      if (String(h.d).slice(0, 4) !== y) continue;
      n += ((Number(h.inn) || 0) - (Number(h.out) || 0)) * fxRate(a.cur);
    }
  }
  return n;
}
function thisYearInvestProfit() {
  const year = new Date().getFullYear(), start = `${year}-01-01`;
  return S.invest.reduce((sum,a) => {
    const rows=(a.hist||[]).slice().sort((x,y)=>String(x.d).localeCompare(String(y.d)));
    const before=rows.filter(x=>String(x.d).slice(0,10)<start);
    const opening=before.length ? Number(before[before.length-1].v)||0 : 0;
    const flow=rows.filter(x=>String(x.d).slice(0,4)===String(year)).reduce((n,x)=>n+(Number(x.inn)||0)-(Number(x.out)||0),0);
    return sum+((Number(a.amount)||0)-opening-flow)*fxRate(a.cur);
  },0);
}
function latestDate() {
  let best = "";
  const scan = (v) => { if (v && String(v).slice(0, 10) > best) best = String(v).slice(0, 10); };
  for (const k of ["cash", "fixed", "receivable", "debt"]) for (const x of S[k]) scan(x.date);
  for (const a of S.invest) { scan(a.updated); for (const h of a.hist || []) scan(h.d); }
  for (const s of S.snaps) scan(s.at);
  return best;
}
function relUpdate(s) {
  if (!s) return "尚未记账";
  return pretty(s) + " 更新";
}
function daysAgo(s) {
  if (!s) return "尚未更新";
  const days = Math.max(0, Math.round((Date.now() - parseDay(s)) / 86400000));
  if (days <= 0) return "今天更新";
  if (days === 1) return "昨天更新";
  return days + "天前更新";
}
function vis(list) {
  const rows = (list === S.invest ? S.invest.filter((x) => !x.archived) : (list || []));
  if (!route.member || route.member === "全部") return rows;
  return rows.filter((x) => !x.owner || x.owner === route.member);
}
function memberList() {
  return (S.members && S.members.length) ? S.members : [{ id: "me", name: "我" }];
}
function moneyHelp(k) {
  const tips = {
    活钱: "随时能用的钱：流动资金 + 投资里标成「活钱」的账户。",
    稳健: "一到三年不急用、波动较小的投资。",
    长期: "五年以上的长钱，股票、指数等。",
    保障: "保险与应急备用，先留够再加风险资产。"
  };
  toast(tips[k] || "");
}
function monthUnupdated(s) {
  if (!s) return "尚未记账";
  const now = new Date();
  const d = new Date(parseDay(s));
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return pretty(s) + " 更新";
  return (now.getMonth() + 1) + " 月未更新";
}
function totals() {
  const cash = sum(vis(S.cash));
  const fixed = sum(vis(S.fixed));
  const invList = vis(S.invest);
  const inv = invList.reduce((n, x) => n + cny(x), 0);
  const rec = sum(vis(S.receivable));
  const debt = sum(vis(S.debt));
  const assets = cash + (S.excludeFixed ? 0 : fixed) + inv + rec;
  const net = assets + debt;
  const ratio = assets ? Math.abs(debt) / assets * 100 : 0;
  const pnl = invList.reduce((n, x) => n + investPnl(x) * fxRate(x.cur), 0);
  const empty = isEmptyBook(S);
  const buckets = { 活钱: cash, 稳健: 0, 长期: 0, 保障: 0 };
  for (const a of invList) buckets[a.bucket || "长期"] = (buckets[a.bucket || "长期"] || 0) + cny(a);
  const last = latestDate();
  const prev = S.snaps.length > 1 ? S.snaps[1] : (S.snaps[0] && S.snaps[0].at !== today() ? S.snaps[0] : null);
  return { cash, fixed, inv, rec, debt, assets, net, ratio, pnl, empty, buckets, last, prev };
}
function captureSnap() {
  const t = totals();
  const snap = { at: today(), assets: t.assets, debt: t.debt, cash: t.cash, fixed: t.fixed, inv: t.inv, rec: t.rec };
  if (S.snaps[0] && S.snaps[0].at === snap.at) S.snaps[0] = snap;
  else S.snaps.unshift(snap);
  if (S.snaps.length > 48) S.snaps.length = 48;
}
function addLog(cat, item) {
  S.logs.unshift({ at: today(), cat, id: item.id, name: item.name, amount: item.amount, cur: item.cur || "CNY" });
  if (S.logs.length > 240) S.logs.length = 240;
}
function weatherState(t) {
  if (t.empty) return { icon: "阴", title: "尚未记账", desc: "记下第一笔资产后，这里会根据负债率和现金缓冲给出晴雨。" };
  if (t.net < 0) return { icon: "雨", title: "资不抵债", desc: "净资产为负，优先处理高息负债，再谈投资。" };
  if (t.ratio >= 50) return { icon: "雨", title: "负债偏高", desc: "负债率 " + t.ratio.toFixed(1) + "% ，建议先把杠杆降下来。" };
  if (t.ratio >= 20) return { icon: "阴", title: "转阴", desc: "负债率 " + t.ratio.toFixed(1) + "% ，留意还款节奏和现金流。" };
  const spend = (Number(S.cashflow.stable) || 0) + (Number(S.cashflow.flex) || 0);
  if (spend > 0 && t.cash < spend * 3) return { icon: "阴", title: "现金偏紧", desc: "流动资金不足 3 个月支出，先补安全垫。" };
  if (t.ratio === 0 && t.assets > 0) return { icon: "晴", title: "晴好", desc: "没有负债，资产结构干净。继续保持更新节奏。" };
  return { icon: "晴", title: "晴好", desc: "负债率 " + t.ratio.toFixed(1) + "% ，整体健康。" };
}
function barH(v, max, cap) {
  if (!max) return 2;
  return Math.max(2, Math.round(Math.abs(v) / max * (cap || 70)));
}
function poly(values, x0, x1, y0, y1) {
  if (!values.length) return "";
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  return values.map((v, i) => {
    const x = values.length === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (values.length - 1);
    const y = y1 - (v - min) / span * (y1 - y0);
    return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
  }).join(" ");
}
function filterHist(hist, range) {
  const now = new Date();
  const all = (hist || []).slice().sort((a, b) => String(a.d).localeCompare(String(b.d)));
  const since = (cut) => {
    const inside = all.filter((h) => parseDay(h.d) >= cut);
    const before = all.filter((h) => parseDay(h.d) < cut);
    return before.length ? [before[before.length - 1], ...inside] : inside;
  };
  if (range === "month") return since(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
  if (range === "1m" || range === "6m") {
    const cut = new Date(now); cut.setMonth(now.getMonth() - (range === "1m" ? 1 : 6));
    return since(cut.getTime());
  }
  if (range === "ytd") return since(new Date(now.getFullYear(), 0, 1).getTime());
  if (range === "1y") {
    const cut = new Date(now); cut.setFullYear(now.getFullYear() - 1);
    return since(cut.getTime());
  }
  if (range === "future") return all.slice(-1);
  if (range === "custom" && route.from && route.to) return since(parseDay(route.from)).filter((h) => h.d <= route.to);
  return all;
}
function chartSeries(list, kind) {
  const pts = [];
  if (!list.length) return pts;
  const start = Number(list[0].v) || 0, t0 = parseDay(list[0].d);
  for (let i = 0; i < list.length; i++) {
    const endDay = parseDay(list[i].d), span = Math.max(0, endDay - t0);
    let netFlow = 0, weightedFlow = 0;
    for (let j = 1; j <= i; j++) {
      const flow = (Number(list[j].inn) || 0) - (Number(list[j].out) || 0);
      netFlow += flow;
      if (span) weightedFlow += flow * Math.max(0, endDay - parseDay(list[j].d)) / span;
    }
    const pnl = (Number(list[i].v) || 0) - start - netFlow;
    const denominator = start + weightedFlow;
    const ownFlow = (Number(list[i].inn) || 0) - (Number(list[i].out) || 0);
    const prevV = i ? Number(list[i - 1].v) || 0 : 0;
    const v = Number(list[i].v) || 0;
    const flowOnly = i > 0 && ownFlow && (
      Math.abs(v - prevV) < .000001 || Math.abs(v - (prevV + ownFlow)) < .000001
    );
    // 只有资金流、没有资产估值的日期仅参与计算，不作为曲线采样点，避免出现人为尖峰。
    if (!flowOnly) pts.push(kind === "pnl" ? pnl : (denominator ? pnl / denominator * 100 : 0));
  }
  return pts;
}

function home() {
  const t = totals();
  const cfT = cfTotals();
  const w = weatherState(t);
  const stats = S.invest.map(investStats);
  const ytd = stats.length ? stats.reduce((n, s) => n + (s.ytd || 0) * (s.net || 0), 0) / Math.max(1, stats.reduce((n, s) => n + Math.max(s.net, 0), 0)) : null;
  const hasYtd = stats.some((s) => s.ytd != null);
  const dA = t.prev ? t.assets - t.prev.assets : 0;
  const dD = t.prev ? t.debt - t.prev.debt : 0;
  const snaps = S.snaps.slice(0, 3).reverse();
  const maxA = Math.max(...snaps.map((s) => Math.abs(s.assets)), 1);
  const yearProfit = thisYearInvestProfit();
  return `<section class="screen on home-screen">
    <div class="pad" style="display:flex;align-items:center;gap:10px;padding-top:18px">
      <h1 style="margin:0;display:flex;align-items:center;gap:8px;flex:1">家庭财务总览 ${hideBtn()}</h1>
      <button class="weather" type="button" onclick="go('weather')">${weatherSvg()}财务晴雨表</button>
    </div>
    <div class="card lav" style="margin:12px 16px;padding:18px 16px" onclick="go('family')">
      <div class="split"><span style="font-size:15px">家庭总资产</span><span class="faint">${monthUnupdated(t.last)}</span></div>
      <div class="n" style="margin:8px 0 2px">${num(t.assets)}<small>元</small></div>
      <div class="faint" style="font-size:12px">${t.empty ? "点此开始记录" : relUpdate(t.last)}</div>
      <div style="display:flex;align-items:end;gap:16px;margin-top:18px">
        <div style="flex:1">
          <div class="spark">${sparkCols(snaps, dA)}</div>
        </div>
        <div style="flex:1.2;font-size:13px;padding-bottom:8px">
          <div class="${dA ? tone(dA) : "muted"}">${dA ? ("资产" + (dA > 0 ? "增加 " : "减少 ") + num(Math.abs(dA)) + " 元") : "资产没有变化"}</div>
          <div class="${dD ? tone(-dD) : "muted"}" style="margin-top:8px">${dD ? ("负债" + (dD > 0 ? "增加 " : "减少 ") + num(Math.abs(dD)) + " 元") : "负债没有变化"}</div>
        </div>
      </div>
    </div>
    <div class="grid2">
      <div class="mini inv-home" onclick="go('invest')">
        <div class="split"><b>投资记账</b><span class="chev-round" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg></span></div>
        <div class="${hasYtd ? tone(ytd) : "faint"}" style="font-size:22px;font-weight:750;margin:10px 0 4px">${hasYtd ? pct(ytd) : "暂无"} <small style="font-size:12px">年化</small></div>
        <div class="faint" style="font-size:12px">${S.invest.length ? relUpdate(t.last) : "尚未记账"}</div>
        <div class="inv-home-returns">
          <div><span>累计收益</span><b class="${tone(t.pnl)}">${(t.pnl / 10000).toFixed(2)}<small> 万</small></b></div>
          <i></i>
          <div><span>今年收益</span><b class="${tone(yearProfit)}">${num(yearProfit)}<small> 元</small></b></div>
        </div>
      </div>
      <div class="mini cf-home-card" onclick="go('cashflow')" style="cursor:pointer">
        <div class="split"><b>年度现金流</b><span class="cf-home-year">${new Date().getFullYear()}</span></div>
        <div class="cf-home-rate">${cfT.income ? Math.round(cfT.rate * 10) / 10 + "%" : "待规划"}<small>${cfT.income ? "储蓄率" : "规划年度收支"}</small></div>
        ${cfChart(cfT, true)}
      </div>
    </div>
  </section>`;
}

function weatherPage() {
  const t = totals();
  const w = weatherState(t);
  const spend = cfTotals().expenses / 12;
  const months = spend > 0 ? t.cash / spend : null;
  return `<section class="screen on gray">
    ${navHead("go('home')", "财务晴雨表")}
    <div class="w-card" style="text-align:center;padding:28px 16px">
      <div style="height:52px;display:grid;place-items:center">${w.icon === "晴" ? `<svg viewBox="0 0 24 18" width="44" height="34"><circle cx="16.5" cy="7" r="4.2" fill="#f6c453"/><path d="M6.2 16.2c-2.2 0-3.9-1.6-3.9-3.5 0-1.7 1.3-3.2 3.1-3.5.4-1.8 2-3.2 4-3.2 1.6 0 3 .8 3.7 2 .6-.3 1.3-.4 2-.4 2.3 0 4.1 1.7 4.1 3.8 0 2.1-1.8 3.8-4.1 3.8H6.2z" fill="#f3f6f2" stroke="#d7e3cf" stroke-width=".6"/></svg>` : w.icon === "雨" ? `<svg viewBox="0 0 24 18" width="44" height="34"><path d="M6 11c-2 0-3.6-1.5-3.6-3.3C2.4 6 3.8 4.6 5.6 4.4 6 2.8 7.5 1.6 9.4 1.6c1.5 0 2.8.8 3.5 1.9.6-.3 1.2-.4 1.9-.4 2.1 0 3.8 1.6 3.8 3.6S17 10 14.8 10H6z" fill="#9aa7b2"/><path d="M8 12.2l-1 4M12 12.2l-1 4M16 12.2l-1 4" stroke="#6ea0d0" stroke-width="1.4" stroke-linecap="round"/></svg>` : `<svg class="wx-ico" viewBox="0 0 24 18" width="36" height="28"><path d="M5.5 14.5c-2.3 0-4.1-1.7-4.1-3.8S3.2 7 5.5 7c.4-2 2.1-3.5 4.2-3.5 1.6 0 3 .8 3.8 2 .7-.3 1.4-.5 2.2-.5 2.4 0 4.3 1.8 4.3 4s-1.9 4-4.3 4H5.5z" fill="#c5ced6"/></svg>`}</div>
      <div style="font-size:22px;font-weight:750;margin:8px 0 6px">${w.title}</div>
      <div class="muted">${w.desc}</div>
    </div>
    <div class="w-card">
      <div class="split"><span class="k">负债率</span><b>${t.empty ? "—" : (S.hide ? "****" : t.ratio.toFixed(2) + "%")}</b></div>
      <div class="split" style="margin-top:10px"><span class="k">净资产</span><b>${num(t.net)} 元</b></div>
      <div class="split" style="margin-top:10px"><span class="k">流动资金</span><b>${num(t.cash)} 元</b></div>
      <div class="split" style="margin-top:10px"><span class="k">现金可撑</span><b>${months == null ? "先填现金流" : months.toFixed(1) + " 个月支出"}</b></div>
    </div>
    <p class="muted pad">晴雨表只看简化版这本账：负债率、净资产、流动资金相对月支出。不会读取完整版持仓。</p>
  </section>`;
}

const CF_INCOME_PRESETS = [
  { name:"工资酬劳", icon:"薪" }, { name:"提取公积金", icon:"积" }, { name:"奖金", icon:"奖" }
];
const CF_EXPENSE_PRESETS = [
  { name:"日常花销", icon:"日", type:"flexible" }, { name:"房租/还款", icon:"房", type:"stable" },
  { name:"保费缴纳", icon:"保", type:"stable" }, { name:"兴趣爱好", icon:"趣", type:"flexible" },
  { name:"孩子花费", icon:"童", type:"flexible" }
];
function cfMultiplier(freq) { return freq === "month" ? 12 : freq === "quarter" ? 4 : 1; }
function cfAnnual(item) { return (Number(item && item.amount) || 0) * cfMultiplier(item && item.freq); }
function cfTotals() {
  const cf = S.cashflow || EMPTY.cashflow;
  const income = (cf.incomeItems || []).reduce((n,x) => n + cfAnnual(x), 0);
  const by = { stable:0, flexible:0, other:0 };
  (cf.expenseItems || []).forEach((x) => { by[x.type] = (by[x.type] || 0) + cfAnnual(x); });
  const expenses = by.stable + by.flexible + by.other;
  const surplus = income - expenses;
  return { income, expenses, surplus, rate:income ? surplus / income * 100 : 0, ...by };
}
function cfFreqLabel(freq) { return freq === "month" ? "月" : freq === "quarter" ? "季" : "年"; }
function cfPreset(kind, name) {
  const list = kind === "income" ? CF_INCOME_PRESETS : CF_EXPENSE_PRESETS;
  return list.find((x) => x.name === name) || { name, icon: kind === "income" ? "收" : "支", type:kind === "expense" ? "other" : "" };
}
function cfIcon(kind, name) {
  const p = cfPreset(kind, name);
  return `<span class="cf-ico cf-ico-${kind}" aria-hidden="true">${esc(p.icon)}</span>`;
}
function cfChart(t, compact) {
  const parts = [
    ["stable", t.stable, "稳定支出"], ["flexible", t.flexible, "弹性支出"], ["other", t.other, "其他支出"]
  ].filter((x) => x[1] > 0 || !compact);
  const income = Math.max(Number(t.income) || 0, 0);
  const expense = Math.max(Number(t.expenses) || 0, 0);
  const scale = income > 0 && expense > income ? income / expense : 1;
  const widths = parts.map((x) => income > 0 ? Math.max(0, Number(x[1]) || 0) * scale / income * 100 : 0);
  const spentWidth = widths.reduce((n,x) => n + x, 0);
  const surplusWidth = income > 0 ? Math.max(0, 100 - spentWidth) : 100;
  return `<div class="cf-chart ${compact ? "compact" : ""}" aria-label="年度现金流构成">
    ${parts.map(([k,v,label],i) => `<div class="cf-chart-part ${k}" style="width:${widths[i]}%">${compact || widths[i] < 10 ? "" : `<span>${label.replace("支出","<br>支出")}</span>`}</div>`).join("")}
    <div class="cf-chart-part surplus" style="width:${surplusWidth}%">${compact ? "" : "<span>年度<br>结余</span>"}</div>
  </div>`;
}
function cfTabs(active) {
  return `<div class="cf-tabs"><button class="${active === "income" ? "on" : ""}" onclick="goCashflowStep('income')">收入预估</button><span>›</span><button class="${active === "expense" ? "on" : ""}" onclick="goCashflowStep('expense')">支出预估</button></div>`;
}
function cashflowPage() {
  const cf = S.cashflow;
  const configured = cf.completed || ((cf.incomeItems || []).length > 0 && (cf.expenseItems || []).length > 0);
  let step = route.cfStep || (configured ? "overview" : cf.started ? "income" : "intro");
  if (configured && step === "intro") step = "overview";
  if (step === "intro") return cfIntroPage();
  if (step === "overview") return cfOverviewPage();
  return cfEstimatePage(step === "expense" ? "expense" : "income");
}
function cfIntroPage() {
  const t = cfTotals(), y = new Date().getFullYear();
  return `<section class="screen on cf-page cf-intro">
    ${navHead("go('home')", "")}
    <div class="cf-intro-copy"><h1>现金流计算器 (${y})</h1><p>预估一年的收入与开支，为自己规划更合理的年度现金流，并追踪开支计划是否与预期吻合。</p></div>
    <div class="cf-legend"><span><i></i>年度收入 ${t.income ? num(t.income) : "****"} 元</span><span><i></i>年度结余 ${t.income ? num(t.surplus) : "****"} 元</span></div>
    ${cfChart(t, false)}
    <button class="cf-primary" onclick="startCashflow()">${S.cashflow.completed ? "继续规划" : "开始"}</button>
  </section>`;
}
function cfEstimatePage(kind) {
  const isIncome = kind === "income", t = cfTotals(), y = new Date().getFullYear();
  const items = isIncome ? S.cashflow.incomeItems : S.cashflow.expenseItems;
  const presets = isIncome ? CF_INCOME_PRESETS : CF_EXPENSE_PRESETS;
  const unused = presets.filter((p) => !items.some((x) => x.name === p.name));
  const metric = isIncome ? t.income : t.expenses;
  const groups = isIncome ? "" : cfExpenseGroups(items);
  return `<section class="screen on cf-page cf-estimate">
    ${navHead(`go('cashflow',{cfStep:'${S.cashflow.completed ? "overview" : "intro"}'})`, `${y} 年现金流`)}
    ${cfTabs(kind)}
    <div class="cf-total"><span>${isIncome ? "预估年度收入" : "预估年度支出"}</span><strong>${num(metric)}</strong><em>元</em></div>
    ${isIncome ? "" : `<div class="cf-flow-meta"><span class="income"><i></i>收入 ${num(t.income)} 元</span><span class="surplus"><i></i>结余 ${num(t.surplus)} 元</span></div>${cfChart(t,false)}`}
    <div class="cf-list-head"><b>${isIncome ? "收入项" : "支出项"}</b>${items.length > 1 ? "<span>↕ 排序</span>" : ""}</div>
    ${items.length ? (isIncome ? `<div class="cf-added-list">${items.map((x) => cfItemRow(kind,x)).join("")}</div>` : groups) : `<div class="cf-choice-list">${presets.map((p) => cfChoice(kind,p)).join("")}</div>`}
    ${items.length ? `<button class="cf-choice cf-more" onclick="openCfPicker('${kind}')">${cfIcon(kind,"更多") }<span>${isIncome ? "添加收入" : "添加支出"}</span><b>＋</b></button>` : `<button class="cf-choice cf-more" onclick="openCfPicker('${kind}')">${cfIcon(kind,"更多") }<span>${isIncome ? "更多其他收入" : "更多其他支出"}</span><b>＋</b></button>`}
    ${items.length && unused.length ? `<p class="cf-collapsed-note">其他类别已收起，可从“${isIncome ? "添加收入" : "添加支出"}”继续选择</p>` : ""}
    ${isIncome ? `<button class="cf-next" onclick="goCashflowStep('expense')" aria-label="下一步">→</button>` : `<button class="cf-primary cf-complete" onclick="finishCashflow()">完成</button>`}
  </section>`;
}
function cfExpenseGroups(items) {
  const labels = { stable:"稳定支出", flexible:"弹性支出", other:"其他支出" };
  return ["stable","flexible","other"].map((type) => {
    const rows = items.filter((x) => (x.type || "other") === type);
    if (!rows.length) return "";
    return `<div class="cf-group ${type}"><div class="cf-group-head"><div><b>${labels[type]}</b><span>总计 ${num(rows.reduce((n,x)=>n+cfAnnual(x),0))} 元/年</span></div>${rows.length > 1 ? "<em>↕ 排序</em>" : ""}</div>${rows.map((x)=>cfItemRow("expense",x)).join("")}</div>`;
  }).join("");
}
function cfChoice(kind,p) { return `<button class="cf-choice" onclick="openCfEditor('${kind}','${esc(p.name)}')">${cfIcon(kind,p.name)}<span>${esc(p.name)}</span><b>＋</b></button>`; }
function cfItemRow(kind,x) { return `<button class="cf-item-row" onclick="openCfEditor('${kind}','${esc(x.name)}','${x.id}')"><span>${esc(x.name)}</span><b>${num(x.amount)} 元/${cfFreqLabel(x.freq)}</b></button>`; }
function cfOverviewPage() {
  const t = cfTotals(), y = new Date().getFullYear();
  return `<section class="screen on cf-page cf-overview">
    <div class="cf-overview-title"><button class="back" onclick="go('home')" aria-label="返回">${chevLeft()}</button><div><h1>年度现金流</h1><button>${y} 年<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button></div><button class="cf-share" onclick="openCfShare()" aria-label="分享"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></svg></button></div>
    <div class="cf-overview-card">
      <div class="cf-overview-metrics"><div><span class="cf-balance-label">预估年度结余 ${hideBtn()}</span><strong>${num(t.surplus)}<em>元</em></strong><small>预估收入 <i class="money-wide">${num(t.income)}</i><i class="money-short">${cfShort(t.income)}</i></small></div><div><span>储蓄率</span><strong>${t.income ? Math.round(t.rate * 10) / 10 + "%" : "—"}</strong><small>预估支出 <i class="money-wide">${num(t.expenses)} 元</i><i class="money-short">${cfShort(t.expenses)}</i></small></div><button onclick="goCashflowStep('income')">编辑 ›</button></div>
      <div class="cf-sankey-card">${cfSankeySvg("combined",false)}<button class="cf-expand" onclick="openCfSankey()" aria-label="展开桑基图">⌗</button></div>
    </div>
    <div class="cf-track-head"><div><h2>支出预算追踪</h2><p>${y} 年度支出 ${num(t.expenses)} 元</p></div><div class="invest-more"><button onclick="route.cfTrackMenu=!route.cfTrackMenu;render({resize:false,keepScroll:true})" aria-label="更多">⋯</button>${route.cfTrackMenu?`<div class="menu inv-menu"><button onclick="toggleCfSort()"><span class="menu-icon drag-icon">⠿</span>${route.cfSort?"保存排序":"支出排序"}</button></div>`:""}</div></div>
    <div class="cf-track-list">${(S.cashflow.expenseItems || []).map(x=>`<div class="${route.cfSort?"sortable-asset":""}" ${route.cfSort?`draggable="true" ondragstart="dragCfExpenseStart(event,'${x.id}')" ondragend="dragInvestEnd(event)" ondragover="event.preventDefault()" ondrop="dropCfExpense(event,'${x.id}')"`:""}>${cfTrackCard(x)}</div>`).join("") || `<div class="cf-track-empty">添加支出计划后，将在这里追踪每月预算</div>`}</div>
  </section>`;
}
function toggleCfSort(){ route.cfSort=!route.cfSort; route.cfTrackMenu=false; if(!route.cfSort) save(); render({resize:false,keepScroll:true}); }
function dragCfExpenseStart(ev,id){ ev.dataTransfer.setData("text/plain",id); ev.currentTarget.classList.add("dragging"); }
function dropCfExpense(ev,targetId){ ev.preventDefault(); const sourceId=ev.dataTransfer.getData("text/plain"); if(!sourceId||sourceId===targetId)return; const list=S.cashflow.expenseItems||[],from=list.findIndex(x=>x.id===sourceId),to=list.findIndex(x=>x.id===targetId); if(from<0||to<0)return; const [item]=list.splice(from,1); list.splice(to,0,item); save(); render({resize:false,keepScroll:true}); }
function openCfShare(){
  const t=cfTotals(),y=new Date().getFullYear();
  showCfSheet(`<div class="cf-share-preview"><div class="cf-share-brand"><span>〽</span><b>Fire</b><em>${y} 年度支出</em></div><div class="cf-share-image">${cfSankeySvg("expense",true,"amount")}</div><div class="cf-share-footer"><div class="cf-share-tags"><span>年度支出 ${cfShort(t.expenses)}</span><span>数据展示 · 金额</span></div><button class="cf-share-save" onclick="window.downloadSimpleCashflowChart?.('${y}-年度现金流')" aria-label="保存图片"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 19h14"/></svg><span>保存图片</span></button></div></div>`);
}
function cfShort(n) { n=Number(n)||0; return Math.abs(n)>=10000 ? (Math.round(n/100)/100)+"万" : num(n); }
function cfTrackCard(x) {
  const monthly = cfAnnual(x)/12;
  return `<div class="cf-track-card"><div class="cf-track-grid"><div><span>${cfFreqLabel(x.freq)}度</span><b>${esc(x.name)}</b></div><div><span><i class="spent"></i>${new Date().getMonth()+1}月支出</span><b>0 元</b></div><div><span><i></i>月度剩余</span><b>${num(monthly)} 元</b></div></div><p>月度支出</p><div class="cf-track-bar"><i style="width:0%"></i></div></div>`;
}
window.getSimpleCashflowChartData = function () {
  const t=cfTotals();
  return {
    income:(S.cashflow.incomeItems||[]).map(x=>({name:x.name,value:cfAnnual(x)})),
    expenses:(S.cashflow.expenseItems||[]).map(x=>({name:x.name,value:cfAnnual(x),type:x.type||"other"})),
    incomeTotal:t.income, expensesTotal:t.expenses, surplus:Math.max(t.surplus,0)
  };
};
function cfSankeySvg(mode,full,metric) {
  const t=cfTotals();
  if (!t.income && !t.expenses) return `<div class="cf-sankey-empty">完成收支预估后生成现金流向图</div>`;
  return `<div class="cf-echart" data-mode="${mode||"combined"}" data-full="${full?"true":"false"}" data-metric="${metric||"amount"}"></div>`;
}
function cfExpenseSankey(W,H,t,items,metric) {
  const leftX=120,midX=470,rightX=800,top=100,bottom=335,total=Math.max(t.expenses,1);
  const groups=[["stable","稳定支出","#db7960","#f1c9bf"],["flexible","弹性支出","#da944e","#f1d3b7"],["other","其他支出","#b9a15b","#eadfb4"]].filter(([k])=>t[k]>0);
  let y=top, paths="", labels="";
  const val=(n)=>metric==="ratio" ? Math.round(n/total*10000)/100+"%" : cfShort(n);
  groups.forEach(([k,label,node,flow])=>{ const gh=Math.max(18,(bottom-top)*t[k]/total), sy=y; paths+=`<path d="M${leftX} ${sy} C300 ${sy},300 ${y},${midX} ${y} L${midX} ${y+gh} C300 ${y+gh},300 ${sy+gh},${leftX} ${sy+gh}Z" fill="${flow}"/>`; paths+=`<rect x="${midX-9}" y="${y}" width="18" height="${gh}" fill="${node}"/>`; labels+=`<text x="${midX}" y="${y-12}" text-anchor="middle" fill="${node}">${label} ${val(t[k])}</text>`; let iy=y; items.filter(x=>(x.type||"other")===k).forEach(x=>{const ih=Math.max(7,gh*cfAnnual(x)/Math.max(t[k],1)); paths+=`<path d="M${midX+9} ${iy} C640 ${iy},640 ${iy},${rightX} ${iy} L${rightX} ${iy+ih} C640 ${iy+ih},640 ${iy+ih},${midX+9} ${iy+ih}Z" fill="${flow}"/><rect x="${rightX}" y="${iy}" width="18" height="${ih}" fill="${node}"/>`; labels+=`<text x="${rightX+30}" y="${iy+ih/2+5}" fill="${node}">${esc(x.name)} ${val(cfAnnual(x))}</text>`; iy+=ih;}); y+=gh; });
  return `<svg class="cf-sankey" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><rect x="${leftX-18}" y="${top}" width="18" height="${bottom-top}" fill="#de7e4e"/>${paths}<text x="${leftX}" y="${top-18}" text-anchor="middle" fill="#de7e4e">预估支出 ${metric==="ratio"?"100.00%":cfShort(t.expenses)}</text>${labels}</svg>`;
}
function openCfSankey() { route.cfSankeyMode="combined"; route.cfSankeyMetric="amount"; renderCfSankeyModal(); }
function renderCfSankeyModal() {
  const mode=route.cfSankeyMode||"combined", metric=route.cfSankeyMetric||"amount", y=new Date().getFullYear();
  showCfSheet(`<div class="cf-sankey-modal"><div class="cf-sankey-toolbar"><div><b>${y} 年度现金流</b><div class="cf-sankey-kind"><button class="${mode==="combined"?"on":""}" onclick="pickCfSankeyMode('combined')">收入与支出</button><button class="${mode==="expense"?"on":""}" onclick="pickCfSankeyMode('expense')">支出</button></div></div><div class="cf-sankey-seg"><button class="${metric==="amount"?"on":""}" onclick="route.cfSankeyMetric='amount';renderCfSankeyModal()">金额</button><button class="${metric==="ratio"?"on":""}" onclick="route.cfSankeyMetric='ratio';renderCfSankeyModal()">比例</button><button class="${metric==="hidden"?"on":""}" onclick="route.cfSankeyMetric='hidden';renderCfSankeyModal()">隐藏数据</button></div><button class="cf-download" onclick="window.downloadSimpleCashflowChart?.('${y}-年度现金流')" aria-label="保存桑基图">↓</button><button class="cf-close-wide" onclick="closeMask()">×</button></div><div class="cf-sankey-stage ${metric==='hidden'?'hide-data':''}">${cfSankeySvg(mode,true,metric)}</div><small>有知有行</small></div>`);
}
function pickCfSankeyMode(mode) { route.cfSankeyMode=mode; route.cfSankeyMenu=false; renderCfSankeyModal(); }
function startCashflow() { S.cashflow.started = true; save(); goCashflowStep("income"); }
function goCashflowStep(step) { route.cfStep = step; render(); }
function finishCashflow() { S.cashflow.started = true; S.cashflow.completed = true; save(); route.cfStep = "overview"; render(); toast("年度现金流已保存"); }
function openCfPicker(kind) {
  const items = kind === "income" ? S.cashflow.incomeItems : S.cashflow.expenseItems;
  const presets = (kind === "income" ? CF_INCOME_PRESETS : CF_EXPENSE_PRESETS).filter((p) => !items.some((x) => x.name === p.name));
  const custom = { name:kind === "income" ? "自定义收入" : "自定义支出", icon:"＋", type:"other" };
  showCfSheet(`<div class="cf-sheet-head"><button onclick="closeMask()">×</button><h3>${kind === "income" ? "添加收入" : "添加支出"}</h3></div><div class="cf-sheet-list">${[...presets,custom].map((p)=>cfChoice(kind,p)).join("")}</div>`);
}
function showCfSheet(html) { const m=document.getElementById("mask"); m.className="mask on cf-mask"; m.innerHTML=`<div class="cf-sheet" role="dialog" aria-modal="true" onclick="event.stopPropagation()">${html}</div>`; }
function openCfEditor(kind,name,id) {
  const list = kind === "income" ? S.cashflow.incomeItems : S.cashflow.expenseItems;
  const old = id ? list.find((x)=>x.id===id) : null;
  const p = cfPreset(kind,name), title = name.startsWith("自定义") ? "" : name;
  const heading = old && kind === "income" ? "修改收入" : esc(old ? old.name : name);
  showCfSheet(`<div class="cf-sheet-head cf-editor-head"><button onclick="closeMask()">×</button><h3>${heading}</h3>${old ? `<button class="cf-top-save" onclick="saveCfItem('${kind}','${old.id}')">保存</button>` : "<span></span>"}</div><div class="cf-editor">
    <label>名称<input id="cfName" value="${esc(old ? old.name : title)}" placeholder="输入名称"></label>
    <label>金额<div class="cf-amount"><select id="cfFreq" onchange="syncCfAnnualHint('${kind}')"><option value="year" ${(old?.freq||"month")==="year"?"selected":""}>每年</option><option value="quarter" ${old?.freq==="quarter"?"selected":""}>每季</option><option value="month" ${(old?.freq||"month")==="month"?"selected":""}>每月</option></select><span class="cf-amount-number"><span class="cf-amount-display" id="cfAmountDisp" aria-hidden="true"></span><input id="cfAmount" class="cf-amount-input" inputmode="decimal" autocomplete="off" value="${old ? esc(formatAmtDigits(old.amount)) : ""}" aria-label="金额" onfocus="onCfAmountInput('${kind}',true)" oninput="onCfAmountInput('${kind}',true)" onblur="paintAmt('cfAmount',false)" onclick="this.setSelectionRange(this.value.length,this.value.length)"></span><span>元</span></div><small class="cf-annual-hint" id="cfAnnualHint">${old ? `年度${kind === "income" ? "收入" : "支出"}金额为 ${num(cfAnnual(old))} 元` : ""}</small></label>
    ${kind === "expense" ? `<label>类型<div class="cf-types">${[["stable","稳定支出"],["flexible","弹性支出"],["other","其他支出"]].map(([v,l])=>`<button class="${(old?.type||p.type||"other")===v?"on":""}" data-type="${v}" onclick="pickCfType(this)">${l}</button>`).join("")}</div></label><p class="cf-type-help">稳定支出适合房租、房贷、保费等固定或刚性费用；弹性支出适合日常消费与兴趣安排。</p>` : ""}
    <div class="cf-editor-actions">${old ? `<button class="cf-delete" onclick="deleteCfItem('${kind}','${old.id}')" aria-label="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M9 4h6l1 3H8l1-3ZM7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg></button>` : `<button class="cf-primary" onclick="saveCfItem('${kind}','')">添加</button>`}</div>
  </div>`);
  setTimeout(()=>{ document.getElementById("cfAmount")?.focus(); onCfAmountInput(kind,true); },0);
}
function onCfAmountInput(kind,focused) {
  const input=document.getElementById("cfAmount");
  if (!input) return;
  const formatted=formatAmtDigits(input.value);
  input.value=formatted;
  input.setSelectionRange(formatted.length,formatted.length);
  paintAmt("cfAmount",focused);
  syncCfAnnualHint(kind);
}
function syncCfAnnualHint(kind) {
  const amount=amtNumber("cfAmount")||0, freq=document.getElementById("cfFreq")?.value||"month", el=document.getElementById("cfAnnualHint");
  if (el) el.textContent=amount ? `年度${kind === "income" ? "收入" : "支出"}金额为 ${num(amount*cfMultiplier(freq))} 元` : "";
}
function pickCfType(el) { el.parentElement.querySelectorAll("button").forEach((x)=>x.classList.remove("on")); el.classList.add("on"); }
function saveCfItem(kind,id) {
  const name = document.getElementById("cfName").value.trim(), amount = amtNumber("cfAmount"), freq = document.getElementById("cfFreq").value;
  if (!name || !(amount > 0)) { toast("请填写名称和金额"); return; }
  const list = kind === "income" ? S.cashflow.incomeItems : S.cashflow.expenseItems;
  const row = { id:id||uid(), name, amount, freq, kind };
  if (kind === "expense") row.type = document.querySelector(".cf-types button.on")?.dataset.type || "other";
  const at = list.findIndex((x)=>x.id===id); if (at >= 0) list[at] = row; else list.push(row);
  S.cashflow.started = true; save(); closeMask(); render();
}
function deleteCfItem(kind,id) { const key=kind === "income" ? "incomeItems" : "expenseItems"; S.cashflow[key]=S.cashflow[key].filter((x)=>x.id!==id); save(); closeMask(); render(); }
function trendSeriesOn() {
  return { cash: true, inv: true, fixed: true, rec: true, debt: true, ...(route.trendOn || {}) };
}
function trendPoints() {
  const t = totals();
  const snaps = (S.snaps || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const list = snaps.map((s) => ({ ...s, net: (Number(s.assets) || 0) + (Number(s.debt) || 0) }));
  const now = { at: today(), assets: t.assets, debt: t.debt, cash: t.cash, fixed: t.fixed, inv: t.inv, rec: t.rec, net: t.net };
  if (!list.length || list[list.length - 1].at !== now.at) list.push(now);
  else list[list.length - 1] = now;
  const range = route.trendRange || "all";
  const nowD = new Date();
  if (range === "ytd") return list.filter((p) => String(p.at).slice(0, 4) === String(nowD.getFullYear()));
  if (range === "1y") {
    const cut = new Date(nowD);
    cut.setFullYear(nowD.getFullYear() - 1);
    return list.filter((p) => parseDay(p.at) >= cut.getTime());
  }
  return list;
}
function setTrendRange(value) {
  route.trendRange = value;
  route.trendRangeOpen = false;
  render({ resize: false, keepScroll: true });
}
function toggleTrend(k) {
  const on = trendSeriesOn();
  on[k] = !on[k];
  route.trendOn = on;
  render({ resize: false, keepScroll: true });
}
function trendSvg() {
  const pts = trendPoints();
  const mode = route.trendMode || "all";
  const on = trendSeriesOn();
  const W = 320, H = 180, L = 42, R = 10, T = 10, B = 24;
  const iw = W - L - R, ih = H - T - B;
  const keys = mode === "net" ? ["net"] : ["cash", "inv", "fixed", "rec", "debt"].filter((k) => on[k]);
  const vals = [];
  pts.forEach((p) => {
    if (mode === "net") vals.push(Number(p.net) || 0);
    else keys.forEach((k) => vals.push(Number(k === "inv" ? p.inv : p[k]) || 0));
  });
  let min = Math.min(0, ...vals);
  let max = Math.max(1, ...vals);
  if (min === max) max = min + 1;
  const yv = (v) => T + ih - (v - min) / (max - min) * ih;
  const xv = (i) => L + (pts.length <= 1 ? iw / 2 : iw * i / (pts.length - 1));
  let grid = "";
  for (let i = 0; i < 5; i++) {
    const v = min + (max - min) * i / 4;
    const yy = yv(v);
    const lab = S.hide ? "****" : (Math.abs(v) >= 10000 ? (v / 10000).toFixed(1).replace(/\.0$/, "") + "万" : String(Math.round(v)));
    grid += `<line x1="${L}" x2="${W - R}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--line)"/>`;
    grid += `<text x="2" y="${yy + 3}" font-size="9" fill="var(--muted)">${lab}</text>`;
  }
  const first = pts[0] ? pretty(pts[0].at) : "";
  const last = pts.length ? pretty(pts[pts.length - 1].at) : "";
  grid += `<text x="${L}" y="${H - 6}" font-size="10" fill="var(--faint)">${first}</text>`;
  grid += `<text x="${W - 88}" y="${H - 6}" font-size="10" fill="var(--faint)">${last}</text>`;
  const colors = { net: "#2eb789", cash: "#c47a52", inv: "#6b5ea7", fixed: "#5aa7b8", rec: "#6b8cce", debt: "#8a8a8a" };
  let paths = "";
  const xs = pts.map((_, i) => xv(i));
  if (mode === "net") {
    const ys = pts.map((p) => yv(p.net || 0));
    if (pts.length === 1) paths += `<line x1="${L}" x2="${W - R}" y1="${ys[0]}" y2="${ys[0]}" stroke="${colors.net}" stroke-width="2"/>`;
    else {
      let d = `M${xs[0]},${ys[0]}`;
      for (let i = 1; i < xs.length; i++) d += `L${xs[i]},${ys[i]}`;
      paths += `<path d="${d}L${xs[xs.length - 1]},${yv(0)}L${xs[0]},${yv(0)}Z" fill="${colors.net}" opacity=".88"/>`;
      paths += `<path d="${d}" fill="none" stroke="${colors.net}" stroke-width="1.4"/>`;
    }
  } else {
    const acc = pts.map(() => 0);
    ["cash", "inv", "fixed", "rec"].filter((k) => on[k]).forEach((k) => {
      const top = pts.map((p, i) => acc[i] + (Number(k === "inv" ? p.inv : p[k]) || 0));
      if (pts.length >= 2) {
        let d = `M${xs[0]},${yv(top[0])}`;
        for (let i = 1; i < xs.length; i++) d += `L${xs[i]},${yv(top[i])}`;
        for (let i = xs.length - 1; i >= 0; i--) d += `L${xs[i]},${yv(acc[i])}`;
        paths += `<path d="${d}Z" fill="${colors[k]}" opacity=".92"/>`;
      }
      top.forEach((v, i) => { acc[i] = v; });
    });
    if (on.debt && pts.length >= 2) {
      let d = `M${xs[0]},${yv(pts[0].debt || 0)}`;
      for (let i = 1; i < xs.length; i++) d += `L${xs[i]},${yv(pts[i].debt || 0)}`;
      paths += `<path d="${d}L${xs[xs.length - 1]},${yv(0)}L${xs[0]},${yv(0)}Z" fill="url(#debtHatch)" opacity=".85"/>`;
    }
  }
  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><pattern id="debtHatch" patternUnits="userSpaceOnUse" width="6" height="6"><path d="M0 6L6 0" stroke="#888" stroke-width="1"/></pattern></defs>
    ${grid}${paths}
  </svg>`;
}
function trendCard() {
  const mode = route.trendMode || "all";
  const range = route.trendRange || "all";
  const rangeLabel = { all: "记账以来", ytd: "今年", "1y": "近1年" }[range] || "记账以来";
  const on = trendSeriesOn();
  const cats = [
    ["cash", "流动资金", "#c47a52"],
    ["inv", "投资理财", "#6b5ea7"],
    ["fixed", "固定资产", "#5aa7b8"],
    ["rec", "应收款", "#6b8cce"],
    ["debt", "负债", "#8a8a8a"]
  ];
  return `<div class="card" style="margin:0 16px 12px;padding:16px;border-radius:18px">
    <div class="split"><b>资产趋势</b><div class="range-select"><button type="button" class="ghost-btn" aria-expanded="${!!route.trendRangeOpen}" onclick="event.stopPropagation();route.trendRangeOpen=!route.trendRangeOpen;render({resize:false,keepScroll:true})">${rangeLabel}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m4 6 4 4 4-4"/></svg></button>${route.trendRangeOpen ? `<div class="dd-menu">${[["all","记账以来"],["ytd","今年"],["1y","近 1 年"]].map(([v,l]) => `<button type="button" class="dd-item ${range === v ? "on" : ""}" onclick="event.stopPropagation();setTrendRange('${v}')"><span>${l}</span>${range === v ? `<span class="tick">✓</span>` : ""}</button>`).join("")}</div>` : ""}</div></div>
    ${mode === "net"
      ? `<div class="trend-legend"><label><i class="chk on" style="background:#2eb789"></i> 净资产</label></div>`
      : `<div class="trend-legend">${cats.map(([k, lab, c]) => `<label onclick="toggleTrend('${k}')"><i class="chk ${on[k] ? "on" : ""}" style="background:${on[k] ? c : "transparent"};border:1.5px solid ${c}"></i> ${lab}</label>`).join("")}</div>`}
    ${trendSvg()}
    <div class="trend-tabs">
      <button type="button" class="${mode === "all" ? "on" : ""}" onclick="route.trendMode='all';render({resize:false,keepScroll:true})">全部</button>
      <button type="button" class="${mode === "net" ? "on" : ""}" onclick="route.trendMode='net';render({resize:false,keepScroll:true})">净资产</button>
    </div>
  </div>`;
}
function sparkCols(snaps, dA) {
  const cols = snaps.length ? snaps.slice(-3) : [{ assets: 0 }, { assets: 0 }, { assets: 0 }];
  while (cols.length < 3) cols.unshift({ assets: 0 });
  const maxA = Math.max(...cols.map((s) => Math.abs(s.assets)), 1);
  return cols.map((s, i) => {
    const last = i === cols.length - 1;
    const changed = last && dA;
    const arr = changed ? (dA > 0 ? "↑" : "↓") : "→";
    return `<div><span class="arr ${changed ? "hot" : ""}">${arr}</span><i class="${changed ? "up" : ""}" style="height:${barH(s.assets, maxA, 52)}px"></i></div>`;
  }).join("");
}
function setCf(key, value) {
  S.cashflow[key] = value === "" ? 0 : Number(value) || 0;
  save();
  const cf = S.cashflow;
  const yearSpend = ((Number(cf.stable) || 0) + (Number(cf.flex) || 0)) * 12;
  const rest = (Number(cf.income) || 0) - yearSpend;
  const rate = cf.income ? rest / cf.income * 100 : null;
  const yearEl = document.getElementById("cfYearSpend");
  const restEl = document.getElementById("cfRest");
  const monthEl = document.getElementById("cfMonth");
  const rateEl = document.getElementById("cfRate");
  if (yearEl) yearEl.textContent = num(yearSpend);
  if (restEl) { restEl.textContent = signedNum(rest); restEl.className = "n " + tone(rest); restEl.style.fontSize = "22px"; }
  if (monthEl) monthEl.textContent = num(rest / 12);
  if (rateEl) rateEl.textContent = rate == null ? "—" : pct(rate);
}

function family() {
  const t = totals();
  const dA = t.prev ? t.assets - t.prev.assets : 0;
  const dD = t.prev ? t.debt - t.prev.debt : 0;
  const p = t.prev || { cash: t.cash, fixed: t.fixed, inv: t.inv, rec: t.rec, debt: t.debt };
  const deltas = [
    ["流动资金", t.cash - (p.cash || 0)],
    ["固定资产", t.fixed - (p.fixed || 0)],
    ["投资理财", t.inv - (p.inv || 0)],
    ["应收款", t.rec - (p.rec || 0)],
    ["负债", t.debt - (p.debt || 0)]
  ];
  const maxD = Math.max(...deltas.map((x) => Math.abs(x[1])), 1);
  const cashPct = t.assets ? t.cash / t.assets * 100 : 0;
  const invPct = t.assets ? t.inv / t.assets * 100 : 0;
  const logs = groupedLogs();
  const compareLabel = t.prev ? "相比" + md(t.prev.at) : "相比上次";
  return `<section class="screen on gray">
    ${navHead("go('home')", "家庭资产记账")}
    <div class="pills">
      <button class="pill ${route.member === "全部" ? "on" : ""}" onclick="route.member='全部';render({resize:false,keepScroll:true})">全部</button>
      ${memberList().filter((m) => m.show !== false).map((m) => `<button class="pill ${route.member === m.name ? "on" : ""}" onclick="route.member='${esc(m.name)}';render({resize:false,keepScroll:true})">${esc(m.name)}</button>`).join("")}
      <button class="manage" onclick="go('manage')">管理 ›</button>
    </div>
    <div class="lav-deep" style="margin:0 16px 12px;padding:16px;border-radius:18px">
      <div class="split"><span class="k">总资产 (元) ${hideBtn()}</span>
        <span class="k" style="display:flex;align-items:center;gap:8px">排除固定资产
          <span class="toggle ${S.excludeFixed ? "on" : ""}" onclick="S.excludeFixed=!S.excludeFixed;save();render({resize:false,keepScroll:true})"><i></i></span>
        </span>
      </div>
      <div class="n">${num(t.assets)}</div>
      <div class="faint" style="font-size:12px;margin:4px 0 8px">${t.empty ? "尚未记账" : relUpdate(t.last)}</div>
      <div class="k">净资产 <b style="color:var(--ink)">${num(t.net)}</b>　负债率 ${t.empty ? "—" : (S.hide ? "****" : t.ratio.toFixed(2) + "%")}</div>
      <div class="inner">
        <div class="split"><span>${compareLabel}</span><button class="faint" onclick="go('calendar')">资产月历 ›</button></div>
        <div class="cmp">
          <div style="display:flex;gap:8px;align-items:center"><span class="ico-asset" aria-hidden="true"></span><div><span class="k">总资产</span><div class="${dA ? tone(dA) : "muted"}">${dA ? "↑ " + num(Math.abs(dA)) : "没有变化"}</div></div></div>
          <div style="display:flex;gap:8px;align-items:center"><span class="ico-debt" aria-hidden="true"></span><div><span class="k">总负债</span><div class="${dD ? tone(-dD) : "muted"}">${dD ? signedNum(dD) : "没有变化"}</div></div></div>
        </div>
        <div class="delta-bars">${deltas.map(([name, d]) => `<div>
          <b class="${d ? tone(name === "负债" ? -d : d) : "faint"}">${!d ? "没有变化" : (S.hide ? "****" : ((d > 0 ? "↑" : "↓") + Math.round(Math.abs(d)).toLocaleString("zh-CN")))}</b>
          <i class="${d ? "on" : ""}" style="height:${barH(d, maxD, 52)}px"></i>
          <span>${name}</span>
        </div>`).join("")}</div>
      </div>
    </div>
    <div class="card" style="margin:0 16px 12px;padding:16px;border-radius:18px">
      <div class="split"><b>资产组成</b><button class="exp" type="button" title="完整查看" onclick="event.stopPropagation();openSankey()" aria-label="放大资产组成">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 3H3v6M21 3h-6v0M3 3l7 7M21 3l-7 7M9 21H3v-6M21 21h-6v0M3 21l7-7M21 21l-7-7"/></svg>
      </button></div>
      <div class="sankey">${t.empty ? `<div class="sankey-empty">记下流动资金或投资后，这里会展开资金流向</div>` : sankeySvg(t)}</div>
      <div class="comp">
        <div><span class="k" style="color:var(--cash-t)">流动资金 ${t.empty ? "—" : cashPct.toFixed(1) + "%"}</span><div>${num(t.cash)} 元</div></div>
        <div><span class="k" style="color:#8b86c8">投资理财 ${t.empty ? "—" : invPct.toFixed(1) + "%"}</span><div>${num(t.inv)} 元</div></div>
        <div><span class="k">负债</span><div>${num(t.debt)}</div></div>
        <div><span class="k">固定资产</span><div>${num(t.fixed)}</div></div>
        <div><span class="k">应收款</span><div>${num(t.rec)}</div></div>
      </div>
    </div>
    ${trendCard()}
    <div class="card" style="margin:0 16px 12px;padding:16px;border-radius:18px">
      <b>更新记录</b>
      ${logs.length ? `<div class="tl" style="margin-top:12px">${logs.map((g) => `<h4>${md(g.at)}</h4>${g.items.map((it) => `<div class="row-card split"><span>${esc(it.name)}</span><b class="nowrap">${money(it.amount, it.cur)}</b></div>`).join("")}`).join("")}
        ${S.logs.length > 8 && !route.showAll ? `<button class="faint" style="display:block;width:100%;padding:8px" onclick="route.showAll=true;render()">查看更多</button>` : ""}
      </div>` : `<div class="faint" style="text-align:center;padding:28px 8px">暂无更新记录</div>`}
    </div>
  </section>`;
}
function groupedLogs() {
  const rows = route.showAll ? S.logs : S.logs.slice(0, 8);
  const map = [];
  for (const it of rows) {
    const at = String(it.at).slice(0, 10);
    const last = map[map.length - 1];
    if (last && last.at === at) last.items.push(it);
    else map.push({ at, items: [it] });
  }
  return map;
}
function ribbon(x0, y0, h0, x1, y1, h1) {
  const m = (x0 + x1) / 2;
  return `M${x0},${y0} C${m},${y0} ${m},${y1} ${x1},${y1} L${x1},${y1 + h1} C${m},${y1 + h1} ${m},${y0 + h0} ${x0},${y0 + h0} Z`;
}
function sankeySvg(t) {
  const debtN = vis(S.debt).length;
  const assets = Math.max(t.assets, 1);
  const debtH = Math.max(8, Math.min(26, Math.abs(t.debt) / assets * 118));
  const netH = 118 - debtH;
  const cashShare = Math.max(0.08, Math.min(0.42, t.cash / assets || 0.12));
  const ch = Math.max(12, 118 * cashShare * 0.38);
  const ih = 118 - ch - 10;
  const y0 = 36;
  const cashY = y0 + 4;
  const invY = y0 + ch + 14;
  return `<svg viewBox="0 0 520 176" preserveAspectRatio="xMidYMid meet">
    <text x="10" y="22" font-size="12" fill="var(--muted)">${debtN}项负债</text>
    <rect x="10" y="${y0}" width="86" height="${debtH}" rx="2" fill="#c8c8c8"/>
    <path d="M18 ${y0 + debtH + 3} H98 Q118 ${y0 + debtH + 3} 118 ${y0 + debtH + 18} V${y0 + debtH + netH - 10} Q118 ${y0 + debtH + netH} 98 ${y0 + debtH + netH} H18 Z" fill="var(--s-green)"/>
    <rect x="12" y="${y0 + debtH + 4}" width="6" height="${netH - 8}" rx="2" fill="#3cbf8a"/>
    <text x="28" y="${y0 + debtH + netH / 2 + 4}" font-size="13" fill="var(--ink)">净资产</text>
    <text x="150" y="22" font-size="12" fill="#8a86c2">负债</text>
    <text x="186" y="22" font-size="12" fill="#8a86c2">总资产</text>
    <rect x="198" y="${y0}" width="12" height="118" rx="2" fill="var(--bar)"/>
    <path d="${ribbon(210, y0, Math.max(10, debtH * 0.7), 198, y0, Math.max(8, debtH * 0.45))}" fill="#bdbdbd" opacity=".7"/>
    <path d="${ribbon(210, y0 + 2, ch, 348, cashY, ch)}" fill="#e0c4b0"/>
    <path d="${ribbon(210, y0 + ch + 10, ih, 348, invY, ih)}" fill="var(--s-purple)"/>
    <rect x="348" y="${cashY}" width="5" height="${ch}" fill="#c47a52"/>
    <text x="360" y="${cashY + ch / 2 + 4}" font-size="12" fill="var(--cash-t)">流动资金</text>
    <text x="360" y="${invY + ih / 2 + 4}" font-size="13" fill="#8a86c2">投资理财</text>
  </svg>`;
}

let skState = { mode: "amt" };
function wan(n, base) {
  if (skState.mode === "hide" || S.hide) return "";
  if (skState.mode === "pct") {
    const den = base || totals().assets || 1;
    return (n / den * 100).toFixed(1) + "%";
  }
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 10000) return sign + (a / 10000).toFixed(2).replace(/\.?0+$/, "") + "万";
  return sign + a.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
function closeSankey() {
  const el = document.getElementById("skFull");
  if (!el) return;
  el.classList.remove("on");
  el.innerHTML = "";
}
function openSankey() { drawSankeyFull(); }
function setSkMode(m) { skState.mode = m; drawSankeyFull(); }
function bindSkPan(el) {
  if (!el) return;
  let down = false, x0 = 0, y0 = 0, sl = 0, st = 0;
  el.onpointerdown = (e) => {
    if (e.button) return;
    down = true; x0 = e.clientX; y0 = e.clientY; sl = el.scrollLeft; st = el.scrollTop;
    try { el.setPointerCapture(e.pointerId); } catch {}
  };
  el.onpointermove = (e) => {
    if (!down) return;
    el.scrollLeft = sl - (e.clientX - x0);
    el.scrollTop = st - (e.clientY - y0);
  };
  el.onpointerup = el.onpointercancel = () => { down = false; };
}
function downloadSankey() {
  const svg = document.querySelector("#skFull svg");
  if (!svg) { toast("暂无可导出的图"); return; }
  const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "家庭资产组成.svg";
  a.click();
}
function drawSankeyFull() {
  const el = document.getElementById("skFull");
  if (!el) return;
  const t = totals();
  const groups = [
    { label: "流动资金", color: "#c47a52", fill: "rgba(196,122,82,.62)", items: vis(S.cash) },
    { label: "投资理财", color: "#6b5ea7", fill: "rgba(92,84,136,.82)", items: vis(S.invest) },
    { label: "固定资产", color: "#8a8a8a", fill: "rgba(140,140,140,.5)", items: vis(S.fixed) },
    { label: "应收款", color: "#7a90a8", fill: "rgba(122,144,168,.5)", items: vis(S.receivable) }
  ].map((g) => {
    const items = g.items.map((x) => ({ name: x.name, v: Math.abs(cny(x)) })).filter((x) => x.v || g.items.length);
    const total = items.reduce((n, x) => n + x.v, 0);
    return { ...g, items, total };
  }).filter((g) => g.total > 0 || g.items.length);
  const leafN = groups.reduce((n, g) => n + Math.max(g.items.length, 1), 0);
  const H = Math.max(340, 72 + leafN * 36);
  const W = 920;
  const yTop = 56, colH = H - 80;
  const assets = Math.max(t.assets, 1);
  const debtAbs = Math.abs(t.debt);
  const debtH = t.empty ? 10 : Math.max(8, Math.min(colH * 0.22, debtAbs / assets * colH));
  const netH = colH - debtH;
  let y = yTop;
  groups.forEach((g) => {
    const share = t.empty ? 1 / Math.max(groups.length, 1) : g.total / assets;
    g.h = Math.max(28, colH * Math.max(share, 0.06));
    g.y = y;
    let iy = y;
    const itemH = g.items.length ? g.h / g.items.length : g.h;
    g.items.forEach((it) => {
      it.h = Math.max(18, itemH);
      it.y = iy;
      iy += it.h;
    });
    y += g.h + 8;
  });
  let paths = "";
  paths += `<rect x="36" y="${yTop}" width="96" height="${debtH}" rx="3" fill="#5c5c5c"/>`;
  paths += `<path d="M40 ${yTop + debtH + 2} H128 Q152 ${yTop + debtH + 2} 152 ${yTop + debtH + 20} V${yTop + colH - 12} Q152 ${yTop + colH} 128 ${yTop + colH} H40 Z" fill="#1e6b56"/>`;
  paths += `<rect x="188" y="${yTop}" width="14" height="${colH}" rx="3" fill="#5c5488"/>`;
  const rDebt = ribbon(132, yTop, debtH, 188, yTop, Math.max(8, debtH * 0.4));
  const rNet = ribbon(132, yTop + debtH + 2, netH - 2, 188, yTop + Math.max(10, debtH * 0.4), colH - Math.max(10, debtH * 0.4));
  paths += `<path d="${rDebt}" fill="#6a6a6a" opacity=".85"/>`;
  paths += `<path d="${rNet}" fill="#1e6b56" opacity=".8"/>`;
  groups.forEach((g) => {
    paths += `<path d="${ribbon(202, g.y, g.h, 348, g.y, g.h)}" fill="${g.fill}"/>`;
    paths += `<rect x="348" y="${g.y}" width="8" height="${g.h}" fill="${g.color}"/>`;
    const lab = skState.mode === "hide" ? g.label : g.label + " " + wan(g.total, assets);
    paths += `<text x="216" y="${g.y + Math.min(g.h / 2 + 4, 16)}" font-size="12" fill="#ddd">${esc(lab)}</text>`;
    g.items.forEach((it) => {
      const h = Math.max(10, it.h - 4);
      paths += `<path d="${ribbon(356, it.y + 2, h, 560, it.y + 2, h)}" fill="${g.fill}"/>`;
      paths += `<rect x="560" y="${it.y + 2 + h / 2 - 1}" width="18" height="2" fill="${g.color}"/>`;
      const ilab = skState.mode === "hide" ? it.name : it.name + "  " + wan(it.v, assets);
      paths += `<text x="586" y="${it.y + it.h / 2 + 4}" font-size="13" fill="#e8e8e8">${esc(ilab)}</text>`;
    });
  });
  const debtLab = wan(-debtAbs, assets);
  const astLab = wan(t.assets, assets);
  const svg = `<svg class="sk-canvas" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#0c0c0e"/>
    <g font-family="-apple-system,PingFang SC,sans-serif">
      <rect x="36" y="16" rx="6" fill="#1c1c1e" width="88" height="32"/>
      <text x="48" y="28" font-size="11" fill="#9a9a9a">负债</text>
      <text x="48" y="42" font-size="12" fill="#ddd">${esc(debtLab || "—")}</text>
      <rect x="132" y="16" rx="6" fill="#1c1c1e" width="100" height="32"/>
      <text x="144" y="28" font-size="11" fill="#8b86c2">总资产</text>
      <text x="144" y="42" font-size="12" fill="#ddd">${esc(astLab || "—")}</text>
      ${paths}
    </g>
  </svg>`;
  const mode = skState.mode;
  el.innerHTML = `<div class="sk-bar">
      <h2>家庭资产组成</h2>
      <select class="sk-dd" onchange="route.member=this.value;drawSankeyFull()">
        <option value="全部" ${route.member === "全部" ? "selected" : ""}>全部</option>
        ${memberList().map((m) => `<option value="${esc(m.name)}" ${route.member === m.name ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
      </select>
      <span class="grow"></span>
      <div class="sk-modes">
        <button class="${mode === "amt" ? "on" : ""}" onclick="setSkMode('amt')">金额</button>
        <button class="${mode === "pct" ? "on" : ""}" onclick="setSkMode('pct')">比例</button>
        <button class="${mode === "hide" ? "on" : ""}" onclick="setSkMode('hide')">隐藏金额</button>
      </div>
      <button class="sk-ico" title="导出" onclick="downloadSankey()">↓</button>
      <button class="sk-ico" title="关闭" onclick="closeSankey()">×</button>
    </div>
    <div class="sk-view">${(t.empty || t.assets <= 0) ? `<div style="padding:48px 24px;color:#888">还没有明细。记下流动资金或投资账户后，这里会展开到每一笔，并可左右拖动。</div>` : svg}</div>`;
  el.classList.add("on");
  bindSkPan(el.querySelector(".sk-view"));
}

function calendarPage() {
  const rows = S.snaps.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return `<section class="screen on gray">
    ${navHead("go('family')", "资产月历")}
    ${rows.length ? rows.map((s) => `<div class="w-card">
      <div class="split"><b>${zhDate(s.at)}</b><span class="muted">${num(s.assets)} 元</span></div>
      <div class="k" style="margin-top:8px">负债 ${num(s.debt)}　现金 ${num(s.cash)}　投资 ${num(s.inv)}</div>
    </div>`).join("") : `<div class="w-card faint" style="text-align:center">还没有快照。更新一笔资产后会出现。</div>`}
  </section>`;
}

function managePage() {
  const ms = memberList();
  const colors = ["#f3b184", "#8bb7e0", "#a8d5b5", "#d5b4e0", "#e8c07a"];
  const sorting = !!route.memSort;
  return `<section class="screen on gray">
    ${navHead("go('family')", "家庭成员", `<button type="button" class="bar-ico ${sorting ? "red" : ""}" onclick="route.memSort=!route.memSort;render({resize:false})" aria-label="排序">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6h11M8 12h8M8 18h5"/><path d="M4 7l2-2 2 2M4 17l2 2 2-2"/></svg>
    </button>`)}
    <p class="muted pad">记录多人家庭资产时，建议添加家庭成员，录入后分别查看每位成员的资产。</p>
    <p class="muted pad">如有需要，你可以找一个方便的时间，和家人面对面坐下来一起讨论、交流和管理家庭资产。</p>
    <div class="mems">
      ${ms.map((m, i) => `<div class="mem">
        <div class="avatar" style="background:${colors[i % colors.length]}"><i class="dot l"></i><i class="dot r"></i><i class="smile"></i></div>
        <b>${esc(m.name)}</b>
        ${sorting ? `<div class="mem-shift">
          <button type="button" onclick="moveMember('${m.id}',-1)">左移</button>
          <button type="button" onclick="moveMember('${m.id}',1)">右移</button>
        </div>` : (m.id !== "me" ? `<button class="sub" onclick="removeMember('${m.id}')">移除</button>` : "")}
      </div>`).join("")}
      ${sorting ? "" : `<button class="mem" type="button" onclick="addMemberDlg()">
        <div class="mem-add">+</div>
        <span class="sub">添加成员</span>
      </button>`}
    </div>
  </section>`;
}
function modalShell(title, desc, body, foot) {
  return `<div class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
    <div class="modal-head">
      <div><h3>${title}</h3>${desc ? `<p>${desc}</p>` : ""}</div>
      <button type="button" class="modal-x" onclick="closeMask()" aria-label="关闭">×</button>
    </div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${foot}</div>
  </div>`;
}
function showModal(html) {
  const m = document.getElementById("mask");
  m.className = "mask on";
  m.innerHTML = html;
}
function historyDuration(hist) {
  const rows = (hist || []).filter((x) => x && x.d).slice().sort((a,b) => String(a.d).localeCompare(String(b.d)));
  if (rows.length < 2) return { days: 0, years: 0 };
  const days = Math.max(0, Math.round((parseDay(rows[rows.length - 1].d) - parseDay(rows[0].d)) / 86400000));
  return { days, years: days / 365.25 };
}
function openMetricHelp(kind, accountId) {
  const account = accountId ? S.invest.find((x) => x.id === accountId) : null;
  const duration = historyDuration(account ? investStats(account).hist : allInvestVirtual().virt.hist);
  if (kind === "mwr") {
    showModal(modalShell("资金加权收益率", "", `<div class="metric-help-copy">“资金加权收益率”考虑了每笔资金进出的影响，适合用来衡量资金进出可控情况下的投资能力。<br><br>采用 Modified Dietz 算法实现。</div>`, `<button type="button" class="modal-ok" onclick="closeMask()">知道了</button>`));
    return;
  }
  showModal(modalShell("年化收益率", "", `<div class="metric-help-copy">“年化收益率”采用 XIRR 算法计算，考虑了每笔资金进出的时间和金额，代表按复利计算的年均收益率。长期来看，是衡量投资能力较好的指标。</div><div class="metric-help-stat"><b>统计时长：</b>${duration.years.toFixed(1)} 年（${duration.days} 天）</div>`, `<button type="button" class="modal-ok" onclick="closeMask()">知道了</button>`));
}
function curMeta(code) {
  if (code === "USD") return { symbol: "$", name: "美元" };
  if (code === "HKD") return { symbol: "HK$", name: "港元" };
  return { symbol: "¥", name: "人民币" };
}
function formatAmtDigits(raw) {
  const s = String(raw ?? "").replace(/[^\d.]/g, "");
  if (!s) return "";
  const dot = s.indexOf(".");
  const intRaw = (dot === -1 ? s : s.slice(0, dot)).replace(/^0+(?=\d)/, "") || "0";
  const frac = dot === -1 ? "" : s.slice(dot + 1).replace(/\D/g, "").slice(0, 2);
  const int = intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (dot === -1) return int;
  return int + "." + frac;
}
function paintAmt(id, focused) {
  const input = document.getElementById(id);
  const disp = document.getElementById(id + "Disp");
  if (!input || !disp) return;
  if (focused == null) focused = document.activeElement === input;
  const formatted = formatAmtDigits(input.value);
  let di = 0, html = "";
  if (!formatted) html = input.dataset.emptyDisplay === "blank" ? "" : `<span style="color:var(--faint)">0</span>`;
  else {
    for (const ch of formatted) {
      if (ch === "," || ch === ".") html += `<span style="color:var(--muted)">${ch}</span>`;
      else { html += `<span style="color:${RAINBOW[di % RAINBOW.length]}">${ch}</span>`; di += 1; }
    }
  }
  if (focused) html += `<i class="amt-caret" style="background:${RAINBOW[di % RAINBOW.length]};box-shadow:0 0 9px ${RAINBOW[di % RAINBOW.length]}"></i>`;
  disp.innerHTML = html;
}
function onAmtInput(id) {
  const input = document.getElementById(id);
  if (!input) return;
  const formatted = formatAmtDigits(input.value);
  input.value = formatted;
  input.setSelectionRange(formatted.length, formatted.length);
  paintAmt(id, true);
  if (typeof syncUpdateHint === "function") syncUpdateHint();
}
function amtNumber(id) {
  const el = document.getElementById(id);
  if (!el) return NaN;
  const raw = String(el.value).replace(/,/g, "").trim();
  return raw === "" ? NaN : Number(raw);
}
function amtField(id, value, cur) {
  const meta = curMeta(cur);
  const shown = formatAmtDigits(value === "" || value == null ? "" : String(value));
  return `<div class="amt-field">
    <b class="amt-sym">${meta.symbol}</b>
    <span class="amt-box">
      <span class="amt-display" id="${id}Disp"></span>
      <input id="${id}" class="amt-input" inputmode="decimal" autocomplete="off" value="${esc(shown)}" data-empty-display="blank" aria-label="金额"
        onfocus="onAmtInput('${id}')" oninput="onAmtInput('${id}')" onblur="paintAmt('${id}',false)" onclick="this.setSelectionRange(this.value.length,this.value.length)" />
    </span>
    <small class="amt-code">${cur || "CNY"}</small>
  </div>`;
}
function addMemberDlg(opts) {
  route.dlg = "member";
  if (!opts || !opts.skipUrl) syncUrl(false);
  showModal(modalShell("添加成员", "录入后可按成员筛选家庭资产", `
    <div>
      <span class="modal-lab">昵称</span>
      <input id="memName" class="modal-input" placeholder="为家人取个名字吧" oninput="syncMemOk()" />
    </div>
    <div class="modal-row"><span>在家庭资产记账中显示该成员</span>
      <span class="toggle on" id="memShow" onclick="this.classList.toggle('on')"><i></i></span>
    </div>
  `, `<button type="button" class="modal-cancel" onclick="closeMask()">取消</button>
     <button type="button" class="modal-ok" id="memOk" disabled onclick="commitMember()">完成</button>`));
  const el = document.getElementById("memName");
  if (el) el.focus();
}
function syncMemOk() {
  const name = (document.getElementById("memName") && document.getElementById("memName").value || "").trim();
  const btn = document.getElementById("memOk");
  if (!btn) return;
  btn.disabled = !name;
  btn.classList.toggle("ready", !!name);
}
function commitMember() {
  const name = (document.getElementById("memName") && document.getElementById("memName").value || "").trim();
  if (!name) { toast("请填写昵称"); return; }
  const showEl = document.getElementById("memShow");
  const show = showEl ? showEl.classList.contains("on") : true;
  if (!S.members) S.members = memberList();
  S.members.push({ id: uid(), name, show });
  save(); closeMask(); render({ resize: false });
}
function removeMember(id) {
  S.members = memberList().filter((m) => m.id !== id);
  if (route.member !== "全部" && !S.members.some((m) => m.name === route.member)) route.member = "全部";
  save(); render({ resize: false });
}
function moveMember(id, dir) {
  const ms = memberList().slice();
  const i = ms.findIndex((m) => m.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ms.length) return;
  const tmp = ms[i]; ms[i] = ms[j]; ms[j] = tmp;
  S.members = ms;
  save(); render({ resize: false });
}

function updateFamily() {
  const cats = CATS.map((c) => ({ ...c, list: vis(listByCat(c.id)) }));
  const cur = cats.find((c) => c.id === route.cat) || cats[0];
  const sorting = !!route.itemSort;
  const grouped = [];
  for (const a of cur.list) {
    const owner = a.owner || "我";
    const last = grouped[grouped.length - 1];
    if (last && last.owner === owner) last.items.push(a);
    else grouped.push({ owner, items: [a] });
  }
  if (!grouped.length) grouped.push({ owner: currentOwner(), items: [] });
  return `<section class="screen on gray">
    ${navHead("go('family')", "更新家庭资产", `<button class="bar-ico" type="button" onclick="importBook()" aria-label="导入">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M5 19h14"/></svg>
    </button><span style="font-size:13px;color:var(--ink)">导入</span>
    <button class="bar-ico" type="button" onclick="route.menu=!route.menu;render({resize:false})" aria-label="更多">···</button>`)}
    ${route.menu ? `<div class="menu">
        <button onclick="exportBook();route.menu=false;render()">导出账本</button>
        <button onclick="importBook();route.menu=false">导入 JSON</button>
        <button onclick="location.href='/records'">切换完整版</button>
      </div>` : ""}
    <div class="cats">
      ${cats.map((c, i) => {
        const value = c.id === "invest" ? vis(S.invest).reduce((n, x) => n + cny(x), 0) : sum(c.list);
        const empty = c.list.length === 0;
        const on = c.id === cur.id ? (c.id === "cash" ? "on-cash" : c.id === "invest" ? "on-inv" : "on-debt") : "";
        return `${i ? `<span class="cat-next">›</span>` : ""}<button class="cat ${on}" onclick="go('update',{cat:'${c.id}'})">
          <b>${c.label}</b>
          <span>${empty && value === 0 && c.id !== "debt" ? "待填写" : num(value) + " 元"}</span>
        </button>`;
      }).join("")}
    </div>
    <button class="hint ${cur.id === "cash" ? "" : "plain"}" onclick="go('help',{cat:'${cur.id}'})"><span>什么是${cur.label}</span><span>›</span></button>
    ${grouped.map((g) => `<div>
      <div class="owner-row"><div class="me">${esc(g.owner)}</div>
        <button class="sort-btn ${sorting ? "on" : ""}" type="button" onclick="route.itemSort=!route.itemSort;render({resize:false,keepScroll:true})" aria-label="排序">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 8l4-4 4 4M8 16l4 4 4-4"/></svg>
        </button>
      </div>
      ${g.items.length ? g.items.map((a) => `<button class="acct" onclick="${sorting ? `moveItem('${cur.id}','${a.id}',1)` : (cur.id === "invest" ? `go('account',{account:'${a.id}'})` : `go('editItem',{cat:'${cur.id}',itemId:'${a.id}'})`)}">
        <b>${esc(a.name)}</b>
        <div class="amt">${money(a.amount, a.cur)}<small>${a.date ? md(a.date) : (a.updated ? relUpdate(a.updated) : "")}${sorting ? " · 点此下移" : ""}</small></div>
      </button>`).join("") : `<div class="faint" style="padding:24px;text-align:center">暂无记录</div>`}
    </div>`).join("")}
    <button class="add-dash" onclick="${cur.id === "invest" ? "go('addInvest')" : `go('addItem',{cat:'${cur.id}'})`}">
      <span>${cur.id === "debt" ? "更多负债" : "继续添加"}</span><span>+</span>
    </button>
  </section>`;
}
function finishUpdate() {
  captureSnap();
  save();
  toast("已保存记录");
  go("family");
}
function helpPage() {
  const c = CATS.find((x) => x.id === route.cat) || CATS[0];
  return `<section class="screen on gray">
    ${navHead(`go('update',{cat:'${c.id}'})`, `什么是${c.label}`)}
    <div class="w-card help"><p>${c.hint}</p><p>金额按记账币种填写，家庭总览会折成人民币显示。</p></div>
  </section>`;
}
function addItemPage() {
  const cat = route.cat || "cash";
  const meta = CATS.find((c) => c.id === cat) || CATS[0];
  const d = route.draft || { name: "", amount: "", cur: "CNY" };
  const ready = d.name.trim() && d.amount !== "" && Number.isFinite(Number(d.amount));
  return `<section class="screen on">
    <div class="add-head">
      <div class="bar" style="padding:0"><span></span><button class="back" onclick="go('update',{cat:'${cat}'})">×</button></div>
      <h1>添加${meta.label}</h1>
      <div class="ex">参考示例</div>
      <div class="ex-row">${(EXAMPLES[cat] || []).map((n) => `<button class="ex-chip" type="button" onclick="fillItemExample('${esc(n)}')">${esc(n)}<small>金额 ****</small></button>`).join("")}</div>
    </div>
    <div class="add-body">
      <div class="field"><label>名称</label><input value="${esc(d.name)}" placeholder="取个名字吧" oninput="draftItem('name',this.value)" /></div>
      <div class="field"><label>金额</label><input type="number" value="${esc(d.amount)}" placeholder="输入金额" oninput="draftItem('amount',this.value)" /></div>
      <div class="field"><label>币种</label>
        <div class="types">${CURS.map((c) => `<button type="button" class="${d.cur === c.code ? "on" : ""}" onclick="draftItem('cur','${c.code}');render()">${c.name}</button>`).join("")}</div>
      </div>
      <button class="ok-btn ${ready ? "ready" : ""}" ${ready ? "" : "disabled"} onclick="commitItem()">确定</button>
    </div>
  </section>`;
}
function editItemPage() {
  const cat = route.cat;
  const item = listByCat(cat).find((x) => x.id === route.itemId);
  if (!item) {
    return `<section class="screen on gray">${navHead(`go('update',{cat:'${cat}'})`, "资产")}<div class="w-card faint" style="text-align:center;padding:28px">没有找到这条记录，或数据仍在同步。</div></section>`;
  }
  return `<section class="screen on">
    ${navHead(`go('update',{cat:'${cat}'})`, esc(item.name), `<button class="danger" onclick="removeItem('${cat}','${item.id}')">删除</button>`)}
    <div class="add-body">
      <div class="field"><label>名称</label><input value="${esc(item.name)}" onchange="patchItem('${cat}','${item.id}',{name:this.value},false)" /></div>
      <div class="field"><label>金额</label><input type="number" value="${item.amount}" onchange="saveEditAmount('${cat}','${item.id}',this.value)" /></div>
      <div class="field"><label>币种</label>
        <div class="types">${CURS.map((c) => `<button type="button" class="${item.cur === c.code ? "on" : ""}" onclick="patchItem('${cat}','${item.id}',{cur:'${c.code}'})">${c.name}</button>`).join("")}</div>
      </div>
      <button class="ok-btn ready" onclick="commitEdit('${cat}','${item.id}')">保存</button>
    </div>
  </section>`;
}
function saveEditAmount(cat, id, value) {
  const item = listByCat(cat).find((x) => x.id === id);
  if (!item) return;
  let n = Number(value);
  if (!Number.isFinite(n)) return;
  if (cat === "debt") n = -Math.abs(n);
  item.amount = n;
  item.date = today();
  save();
}
function fillItemExample(name) {
  route.draft = { ...(route.draft || { amount: "", cur: "CNY" }), name };
  render();
}
function draftItem(key, value) {
  route.draft = { name: "", amount: "", cur: "CNY", ...(route.draft || {}), [key]: value };
  const btn = document.querySelector(".ok-btn");
  const d = route.draft;
  const ready = d.name.trim() && d.amount !== "" && Number.isFinite(Number(d.amount));
  if (btn) { btn.classList.toggle("ready", ready); btn.disabled = !ready; }
}
function commitItem() {
  const cat = route.cat || "cash";
  const d = route.draft || {};
  let amount = Number(d.amount);
  if (!d.name || !Number.isFinite(amount)) return;
  if (cat === "debt") amount = -Math.abs(amount);
  const item = { id: uid(), name: d.name.trim(), cur: d.cur || "CNY", amount, date: today(), owner: currentOwner() };
  S[cat].push(item);
  addLog(cat, item);
  captureSnap();
  route.draft = null;
  save();
  go("update", { cat });
}
function removeItem(cat, id) {
  if (!confirm("删除这条记录？")) return;
  if (cat === "invest") S.invest = S.invest.filter((x) => x.id !== id);
  else S[cat] = (S[cat] || []).filter((x) => x.id !== id);
  S.logs = S.logs.filter((x) => !(x.cat === cat && x.id === id));
  captureSnap();
  save();
  toast("已删除");
  if (cat === "invest" && (route.name === "account" || route.name === "settings")) go("invest");
  else go(route.name === "manage" ? "manage" : "update", { cat });
}
function archiveInvest(id) {
  const a = S.invest.find((x) => x.id === id);
  if (!a) return;
  a.archived = !a.archived;
  save();
  toast(a.archived ? "已归档资产" : "已恢复资产");
  go("invest");
}
function archiveInvestFromSort(id) {
  const a = S.invest.find((x) => x.id === id);
  if (!a) return;
  a.archived = true;
  save();
  toast("已归档资产，保存排序后隐藏");
  render({ resize: false, keepScroll: true });
}
function restoreArchivedInvest(id) {
  const a = S.invest.find((x) => x.id === id);
  if (!a) return;
  a.archived = false;
  save();
  toast("已恢复资产");
  render({ resize: false, keepScroll: true });
}
function setInvestSort(sort) {
  route.investSort = sort;
  route.invMenu = false;
  render({ resize: false });
}
function beginInvestSort() {
  route.sorting = true; route.invMenu = true; route.sortMenu = false; render({ resize: false });
}
function finishInvestSort() {
  route.sorting = false; route.invMenu = false; save(); render({ resize: false });
}
function dragInvestStart(ev, id) { ev.dataTransfer.setData("text/plain", id); ev.currentTarget.classList.add("dragging"); }
function dragInvestEnd(ev) { ev.currentTarget.classList.remove("dragging"); }
function dropInvest(ev, targetId) {
  ev.preventDefault();
  const sourceId = ev.dataTransfer.getData("text/plain");
  if (!sourceId || sourceId === targetId) return;
  const from = S.invest.findIndex((x) => x.id === sourceId), to = S.invest.findIndex((x) => x.id === targetId);
  if (from < 0 || to < 0) return;
  const [item] = S.invest.splice(from, 1); S.invest.splice(to, 0, item); save(); render({ resize: false });
}
function summaryRows(summary) {
  const ids = new Set(summary && summary.ids || []);
  return vis(S.invest).filter((a) => ids.has(a.id));
}
function summaryStats(summary) {
  const rows = summaryRows(summary);
  const amount = rows.reduce((n, a) => n + cny(a), 0);
  const pnl = rows.reduce((n, a) => n + investPnl(a) * fxRate(a.cur), 0);
  return { rows, amount, pnl };
}
function saveSummaryDraft() {
  const name = String(document.getElementById("summaryName")?.value || "").trim();
  const ids = [...document.querySelectorAll("input[data-summary-id]:checked")].map((x) => x.dataset.summaryId);
  if (!name) return toast("请填写汇总名称");
  if (!ids.length) return toast("至少选择一项资产");
  S.summaries.push({ id: uid(), name, ids });
  save();
  go("invest");
}
function removeSummary(id) {
  S.summaries = S.summaries.filter((x) => x.id !== id); save(); render({ resize: false });
}
function addSummaryPage() {
  return `<section class="screen on gray add-summary-page">
    ${navHead("go('invest')", "添加汇总", `<button class="bar-ico" onclick="go('invest')" aria-label="关闭">×</button>`)}
    <div class="w-card"><div class="field"><label>汇总名称</label><input id="summaryName" placeholder="取个名字吧" /></div></div>
    <div class="pad"><b style="font-size:18px">包含资产</b></div>
    <div class="w-card summary-picker">${vis(S.invest).map((a) => `<label class="summary-check"><span>${esc(a.name)}</span><input type="checkbox" data-summary-id="${a.id}" /><i></i></label>`).join("")}</div>
    <button class="dock-cta" onclick="saveSummaryDraft()">确定</button>
  </section>`;
}
function moveItem(cat, id, dir) {
  const list = cat === "invest" ? S.invest : (S[cat] || []);
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
  save();
  render({ resize: false, keepScroll: true });
}
function patchItem(cat, id, patch, rerender) {
  const item = listByCat(cat).find((x) => x.id === id);
  if (!item) return;
  Object.assign(item, patch);
  if (cat !== "invest") item.date = today();
  save();
  if (rerender !== false) render();
}
function patchInvest(id, patch, rerender) {
  const item = S.invest.find((x) => x.id === id);
  if (!item) return;
  Object.assign(item, patch);
  save();
  if (rerender !== false) render();
}
function commitEdit(cat, id) {
  const item = listByCat(cat).find((x) => x.id === id);
  if (!item) return;
  item.date = today();
  captureSnap();
  addLog(cat, item);
  save();
  go("update", { cat });
  toast("已保存");
}

function investHome() {
  const t = totals();
  const all = { amount: t.inv, inAmt: 0, outAmt: 0, hist: [] };
  for (const a of vis(S.invest)) {
    all.inAmt += (a.inAmt || 0) * fxRate(a.cur);
    all.outAmt += (a.outAmt || 0) * fxRate(a.cur);
  }
  const st = investStats(all);
  st.pnl = t.pnl;
  st.mwr = all.inAmt - all.outAmt > 0 ? t.pnl / (all.inAmt - all.outAmt) * 100 : null;
  const ytds = vis(S.invest).map(investStats).filter((s) => s.ytd != null);
  st.ytd = ytds.length ? ytds.reduce((n, s) => n + s.ytd * Math.max(s.net, 0), 0) / Math.max(1, ytds.reduce((n, s) => n + Math.max(s.net, 0), 0)) : null;
  const investActions = `<button class="ghost-btn faint" onclick="openReminder()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="vertical-align:-2px;margin-right:4px"><path d="M6 9a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9"/><path d="M10 21h4"/></svg>${S.reminder ? "每月" + S.reminder + "日" : "记账提醒"}
    </button>`;
  return `<section class="screen on">
    ${navHead("go('home')", "投资记账", investActions)}
    <div class="invest-subhead"><b>分组汇总</b></div>
    <div class="summary-strip">
      <div class="inv summary-card" onclick="go('summary')"><div class="k">默认汇总 (元) ${hideBtn()}</div><div class="n" style="margin:6px 0 14px">${num(t.inv)}</div><div class="split"><span class="summary-metric"><span class="summary-metric-label">累计收益</span><b class="summary-metric-value ${S.invest.length ? tone(t.pnl) : "faint"}">${S.invest.length ? num(t.pnl) : "暂无"}</b></span><span class="summary-metric"><span class="summary-metric-label">年化收益率</span><b class="summary-metric-value ${st.ytd == null ? "faint" : tone(st.ytd)}">${st.ytd == null ? "暂无" : pct(st.ytd)}</b></span></div></div>
      ${S.summaries.map((g) => { const x = summaryStats(g); return `<div class="inv summary-card custom-summary" onclick="go('summary',{summaryId:'${g.id}'})"><div class="split"><b>${esc(g.name)}</b><button class="summary-remove" onclick="event.stopPropagation();removeSummary('${g.id}')">×</button></div><div class="n" style="margin:6px 0 14px">${num(x.amount)}</div><div class="split"><span class="summary-metric"><span class="summary-metric-label">累计收益</span><b class="summary-metric-value ${tone(x.pnl)}">${num(x.pnl)}</b></span><span class="faint">${x.rows.length} 项资产</span></div></div>`; }).join("")}
      <button class="add-summary-card" onclick="go('addSummary')"><span>＋</span><b>添加汇总</b></button>
    </div>
    <div class="pad split" style="margin-bottom:8px">
      ${invFilterSelect()}
      <div class="invest-more"><button onclick="route.invMenu=!route.invMenu;route.impMenu=false;closeDrop();render({resize:false})" aria-label="更多">⋯</button>
      ${route.invMenu ? `<div class="menu inv-menu">
        <button onclick="${route.sorting ? "finishInvestSort()" : "beginInvestSort()"}"><span class="menu-icon drag-icon">⠿</span>${route.sorting ? "保存排序" : "资产排序"}</button>
        <button onclick="importLedger();route.invMenu=false;render({resize:false})"><span class="menu-icon" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17M3.5 14h17M9 9.5V19M15 9.5V19"/></svg></span>导入账本</button>
        <button onclick="route.showArchived=true;route.invMenu=false;route.sortMenu=false;render({resize:false})"><span class="menu-icon archive-icon">▣</span>查看已归档资产</button>
        ${route.showArchived ? `<button onclick="route.showArchived=false;route.invMenu=false;render({resize:false})">↩　返回当前资产</button>` : ""}
      </div>` : ""}</div>
    </div>
    ${filteredInvest().length ? filteredInvest().map((a) => {
      const s = investStats(a);
      const unit = a.cur === "USD" ? "美元" : a.cur === "HKD" ? "港元" : "元";
      return `<div class="asset ${route.sorting ? "sortable-asset" : ""}" ${route.sorting ? `draggable="true" ondragstart="dragInvestStart(event,'${a.id}')" ondragend="dragInvestEnd(event)" ondragover="event.preventDefault()" ondrop="dropInvest(event,'${a.id}')"` : ""}>
        <div class="split"><div style="display:flex;align-items:center;gap:10px;min-width:0"><div style="display:flex;align-items:center;gap:10px;min-width:0">${a.market ? marketIco(a.market, 22) : ""}</div><div class="asset-name-line" style="display:flex;align-items:baseline;gap:6px;min-width:0;white-space:nowrap"><b style="overflow:hidden;text-overflow:ellipsis">${esc(a.name)}</b><span class="faint" style="font-size:12px;flex:none">· ${daysAgo(a.updated)}</span></div></div>
          <button class="ghost-btn" onclick="event.stopPropagation();openUpdate('${a.id}')">更新收益</button></div>
        <div class="metric" onclick="go('account',{account:'${a.id}'})">
          <div><div class="k">资产 (${unit})</div><b>${num(a.amount)}</b></div>
          <div><div class="k">累计收益 (${unit})</div><b class="${tone(s.pnl)}">${num(s.pnl)}</b></div>
          <div><div class="k">年化收益率</div><b class="${s.ytd == null ? "faint" : tone(s.ytd)}">${s.ytd == null ? "暂无" : pct(s.ytd)}</b></div>
        </div>
        ${(route.sorting || route.showArchived) ? `<div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="archive-sort-btn" type="button" onclick="event.stopPropagation();${route.showArchived ? `restoreArchivedInvest('${a.id}')` : `archiveInvestFromSort('${a.id}')`}">${route.showArchived ? "恢复" : "归档"}</button></div>` : ""}
      </div>`;
    }).join("") : `<div class="faint" style="text-align:center;padding:32px 16px">还没有投资资产</div>`}
    ${route.showArchived ? "" : `<button class="add-dash" onclick="go('addInvest')">+ 添加投资资产</button>`}
  </section>`;
}

function addInvestPage() {
  const d = route.draft || { name: "", amount: "", bucket: "长期", cur: "CNY", expected: S.expected || 8, market: "CN" };
  const ready = d.name.trim() && d.amount !== "" && Number.isFinite(Number(d.amount));
  return `<section class="screen on">
    <div class="add-head">
      <div class="bar" style="padding:0"><span></span><button class="back" onclick="go('invest')">×</button></div>
      <h1>添加投资资产</h1>
      <div class="ex">参考示例</div>
      <div class="ex-row">${EXAMPLES.invest.map((n) => `<button class="ex-chip" type="button" onclick="fillExample('${n}')">${n}<small>金额 ****</small></button>`).join("")}</div>
    </div>
    <div class="add-body">
      <div class="field"><label><svg class="lab-ico" viewBox="0 0 24 24" fill="none" stroke="#e07a5f" stroke-width="1.8"><path d="M4 20l4.5-1.2L19 8.3a1.5 1.5 0 0 0 0-2.1L17.8 5a1.5 1.5 0 0 0-2.1 0L5.2 15.5 4 20z"/></svg>资产名称</label><input id="invName" placeholder="取个名字吧" value="${esc(d.name)}" oninput="draftField('name',this.value)" /></div>
      <div class="field"><label><svg class="lab-ico" viewBox="0 0 24 24" fill="none" stroke="#3d8bfd" stroke-width="1.8"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/></svg>当前资产金额</label><input type="number" placeholder="输入金额" value="${esc(d.amount)}" oninput="draftField('amount',this.value)" /></div>
      <div class="field"><label><svg class="lab-ico" viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.45 3.6 5.45 3.6 9S14.4 18.55 12 21c-2.4-2.45-3.6-5.45-3.6-9S9.6 5.45 12 3Z"/></svg>市场</label>
        ${marketSelect("draftMarketMenu", d.market || "CN", "pickDraftMarket")}
      </div>
      <div class="field"><label><svg class="lab-ico" viewBox="0 0 24 24" fill="none" stroke="#6b8cff" stroke-width="1.8"><path d="M12 4a8 8 0 1 1-5.6 2.4"/><path d="M12 4v4"/></svg>资产类型</label>
        <div class="types">${["活钱", "稳健", "长期"].map((b) => `<button type="button" class="${d.bucket === b ? "on" : ""}" onclick="draftField('bucket','${b}');render()">${b}</button>`).join("")}</div>
      </div>
      <button class="more" type="button" onclick="route.more=!route.more;render()">币种等更多设置 ›</button>
      ${route.more ? `<div class="field"><label>币种</label>
        <div class="types">${CURS.map((c) => `<button type="button" class="${d.cur === c.code ? "on" : ""}" onclick="draftField('cur','${c.code}');render()">${c.name}</button>`).join("")}</div>
      </div>
      <div class="field"><label>预期年化 %</label><input type="number" value="${d.expected}" oninput="draftField('expected',this.value)" /></div>` : ""}
      <button class="ok-btn ${ready ? "ready" : ""}" type="button" ${ready ? "" : "disabled"} onclick="commitInvest()">确定</button>
    </div>
  </section>`;
}

function chartBlock(hist, expected, unit = "元") {
  const kind = route.chartKind || "mwr";
  const range = route.chartRange || "all";
  const list = filterHist(hist, range);
  const series = chartSeries(list, kind);
  const benchRows = kind === "mwr" ? filterHist(benchState.items.map((x) => ({ d:x.d, v:x.c })), range).filter((x) => (!list[0] || x.d >= list[0].d) && (!list.length || x.d <= list[list.length - 1].d)) : [];
  const benchStart = benchRows[0] ? Number(benchRows[0].v) : 0;
  const benchSeries = benchStart ? benchRows.map((x) => (Number(x.v) / benchStart - 1) * 100) : [];
  const first = list[0] ? pretty(list[0].d) : "";
  const last = list.length ? pretty(list[list.length - 1].d) : "";
  const yMax = Math.max(...series, ...benchSeries, 0);
  const yMin = Math.min(...series, ...benchSeries, 0);
  let expEnd = 0;
  if (expected && list.length >= 2 && kind === "mwr") {
    const years = Math.max(0.05, (parseDay(list[list.length - 1].d) - parseDay(list[0].d)) / 365 / 86400000);
    expEnd = Number(expected) * years;
  }
  const scaleMin = Math.min(yMin, 0, expected && kind === "mwr" ? 0 : 0);
  const scaleMax = Math.max(yMax, expEnd, 1);
  const yAt = (v) => 154 - (v - scaleMin) / (scaleMax - scaleMin || 1) * 128;
  const xAt = (i, n) => n <= 1 ? 180 : 18 + 316 * i / (n - 1);
  let path = "";
  if (series.length) {
    path = series.map((v, i) => (i ? "L" : "M") + xAt(i, series.length).toFixed(1) + " " + yAt(v).toFixed(1)).join(" ");
  }
  const benchPath = benchSeries.map((v, i) => (i ? "L" : "M") + xAt(i, benchSeries.length).toFixed(1) + " " + yAt(v).toFixed(1)).join(" ");
  const expPath = expected && list.length >= 2 && kind === "mwr"
    ? `M20 ${yAt(0).toFixed(1)} L350 ${yAt(expEnd).toFixed(1)}`
    : "";
  const area = kind === "pnl" && path ? `${path} L${xAt(series.length - 1, series.length).toFixed(1)} 154 L${xAt(0, series.length).toFixed(1)} 154 Z` : "";
  const lineColor = kind === "mwr" ? "#ef5b19" : "#3297f6";
  const label = kind === "mwr" ? "资金加权收益率" : "累计收益";
  const bench = benchMeta();
  trendHoverModel = { kind, main:series, bench:benchSeries, dates:list.map((x) => x.d), label, benchLabel:bench.label, color:lineColor, unit, xAt, yAt };
  return `<div class="trend-tabs">
      <button type="button" class="${kind === "mwr" ? "on" : ""}" onclick="event.stopPropagation();setChartKind('mwr')">收益率曲线</button>
      <button type="button" class="${kind === "pnl" ? "on" : ""}" onclick="event.stopPropagation();setChartKind('pnl')">累计收益曲线</button>
    </div>
    <div class="trend-controls"><div class="trend-periods">
      <button class="${range === "month" ? "on" : ""}" onclick="setChartRange('month')">本月</button><button class="${range === "1m" ? "on" : ""}" onclick="setChartRange('1m')">近1月</button><button class="${range === "6m" ? "on" : ""}" onclick="setChartRange('6m')">近6月</button><button class="${range === "ytd" ? "on" : ""}" onclick="setChartRange('ytd')">本年</button><button class="${range === "all" ? "on" : ""}" onclick="setChartRange('all')">全部</button><button class="calendar-pill ${range === "custom" ? "on" : ""}" onclick="openCustomRange()" aria-label="自定义日期" title="自定义日期"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v3M17 3v3M4 9h16"/><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 13h3M13 13h3M8 17h3"/></svg></button>
    </div></div>
    <div class="trend-legend"><span><i style="background:${lineColor}"></i>${label}</span>${kind === "mwr" ? `<div class="bench-select"><button type="button" onclick="event.stopPropagation();route.benchOpen=!route.benchOpen;render({resize:false,keepScroll:true})"><i style="background:#4a90d9"></i><b>${esc(bench.label)}</b><svg class="bench-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg></button>${route.benchOpen ? `<div class="bench-menu">${SIMPLE_BENCHMARKS.map((x) => `<button type="button" class="${x.key === bench.key ? "on" : ""}" onclick="event.stopPropagation();pickBenchmark('${x.key}')"><span>${esc(x.label)}</span>${x.key === bench.key ? "✓" : ""}</button>`).join("")}</div>` : ""}</div><span><i class="dash"></i>预期收益率 ${expected ? expected + "%" : ""}</span>` : ""}</div>
    <div class="scroll-x trend-chart-wrap">
      <svg class="chart" viewBox="0 0 360 170" preserveAspectRatio="xMidYMid meet" onpointermove="moveTrendHover(event,this)" onpointerleave="leaveTrendHover(this)">
        <defs><linearGradient id="trendFill${kind}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lineColor}" stop-opacity=".34"/><stop offset="1" stop-color="${lineColor}" stop-opacity=".02"/></linearGradient></defs>
        <path d="M18 26H334 M18 68H334 M18 110H334 M18 154H334" fill="none" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
        ${expPath ? `<path d="${expPath}" fill="none" stroke="var(--dash)" stroke-width="1.4" stroke-dasharray="3 4"/>` : ""}
        ${benchPath ? `<path d="${benchPath}" fill="none" stroke="#4a90d9" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
        ${area ? `<path d="${area}" fill="url(#trendFill${kind})"/>` : ""}${path ? `<path d="${path}" fill="none" stroke="${lineColor}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />` : `<text x="110" y="90" font-size="12" fill="var(--faint)">当前区间暂无数据</text>`}
        <line data-hover-line x1="18" x2="18" y1="24" y2="154" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" style="display:none;pointer-events:none"/>
        <circle data-hover-main cx="0" cy="0" r="4" fill="var(--card)" stroke="${lineColor}" stroke-width="2" style="display:none;pointer-events:none"/>
        <circle data-hover-bench cx="0" cy="0" r="3.5" fill="var(--card)" stroke="#4a90d9" stroke-width="2" style="display:none;pointer-events:none"/>
        ${series.map((v,i) => `<circle cx="${xAt(i,series.length)}" cy="${yAt(v)}" r="7" fill="transparent" tabindex="0" onclick="toast('${list[Math.min(i,list.length-1)]?.d || ""}　${kind === "pnl" ? num(v) + " " + unit : pct(v)}')"><title>${list[Math.min(i,list.length-1)]?.d || ""} ${kind === "pnl" ? num(v) + " " + unit : pct(v)}</title></circle>`).join("")}
        <text x="18" y="168" font-size="10" fill="var(--faint)">${first}</text><text x="286" y="168" font-size="10" fill="var(--faint)">${last}</text>
        <text x="346" y="29" text-anchor="end" font-size="9" fill="var(--faint)">${kind === "pnl" ? num(scaleMax) : scaleMax.toFixed(1) + "%"}</text><text x="346" y="154" text-anchor="end" font-size="9" fill="var(--faint)">${kind === "pnl" ? num(scaleMin) : scaleMin.toFixed(1) + "%"}</text>
      </svg>
      <div class="trend-hover-tip" role="status"><b data-tip-date></b><span><em><i style="background:${lineColor}"></i>${label}</em><strong data-tip-main-value></strong></span>${kind === "mwr" ? `<span><em><i style="background:#4a90d9"></i>${esc(bench.label)}</em><strong data-tip-bench-value></strong></span>` : ""}</div>
    </div>`;
}
let yearDetailModel = null;
function benchmarkReturn(start, end, annualized) {
  const rows = (benchState.items || []).filter((x) => x.d <= end);
  if (!rows.length) return null;
  const before = rows.filter((x) => x.d <= start);
  const first = before.length ? before[before.length - 1] : rows.find((x) => x.d >= start);
  const last = rows[rows.length - 1];
  if (!first || !last || !(Number(first.c) > 0) || last.d <= first.d) return null;
  const ratio = Number(last.c) / Number(first.c);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  if (!annualized) return (ratio - 1) * 100;
  const years = (parseDay(last.d) - parseDay(first.d)) / 31536000000;
  return years > 0 ? (Math.pow(ratio, 1 / years) - 1) * 100 : null;
}
function yearBenchmark(hist, y) {
  const rows = (hist || []).slice().sort((a,b) => String(a.d).localeCompare(String(b.d)));
  if (!rows.length) return null;
  const start = `${y}-01-01` > rows[0].d ? `${y}-01-01` : rows[0].d;
  const end = `${y}-12-31` < rows[rows.length - 1].d ? `${y}-12-31` : rows[rows.length - 1].d;
  return start < end ? benchmarkReturn(start, end, false) : null;
}
function yearBenchHeader() {
  const bench = benchMeta();
  return `<div class="bench-select year-bench-head"><button type="button" onclick="event.stopPropagation();route.yearBenchOpen=!route.yearBenchOpen;route.benchOpen=false;render({resize:false,keepScroll:true})"><b>${esc(bench.label)}</b><svg class="bench-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg></button>${route.yearBenchOpen ? `<div class="bench-menu">${SIMPLE_BENCHMARKS.map((x) => `<button type="button" class="${x.key === bench.key ? "on" : ""}" onclick="event.stopPropagation();pickBenchmark('${x.key}')"><span>${esc(x.label)}</span>${x.key === bench.key ? "✓" : ""}</button>`).join("")}</div>` : ""}</div>`;
}
function yearRow(hist, y) {
  const v = yearMwr(hist, y);
  const bv = yearBenchmark(hist, y);
  const now = new Date();
  const sub = Number(y) === now.getFullYear() ? "年初至 " + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) : "全年";
  return `<tr><td>${y}年<div class="k">${sub}</div></td><td class="${v == null ? "faint" : tone(v)}">${v == null ? "暂无" : pct(v)}</td><td class="${bv == null ? "faint" : tone(bv)}">${bv == null ? "暂无" : pct(bv)}</td></tr>`;
}
function openYearDetails() {
  const model = yearDetailModel;
  if (!model || !model.years.length) return;
  const st = model.stats;
  const rows = (model.hist || []).slice().sort((a,b) => String(a.d).localeCompare(String(b.d)));
  const annualBench = rows.length > 1 ? benchmarkReturn(rows[0].d, rows[rows.length - 1].d, true) : null;
  const allBench = rows.length > 1 ? benchmarkReturn(rows[0].d, rows[rows.length - 1].d, false) : null;
  const body = `<div class="scroll-x"><table class="table">
    <tr><th>时间</th><th>资金加权收益率</th><th>${esc(benchMeta().label)}</th></tr>
    <tr><td>年化收益率</td><td class="${st.ytd == null ? "faint" : tone(st.ytd)}">${st.ytd == null ? "暂无" : pct(st.ytd)}</td><td class="${annualBench == null ? "faint" : tone(annualBench)}">${annualBench == null ? "暂无" : pct(annualBench)}</td></tr>
    ${model.years.map((y) => yearRow(model.hist, y)).join("")}
    <tr><td>记账以来</td><td class="${st.mwr == null ? "faint" : tone(st.mwr)}">${st.mwr == null ? "暂无" : pct(st.mwr)}</td><td class="${allBench == null ? "faint" : tone(allBench)}">${allBench == null ? "暂无" : pct(allBench)}</td></tr>
  </table></div>`;
  showModal(modalShell("历年明细", "", body, `<button type="button" class="modal-ok" onclick="closeMask()">知道了</button>`));
}
function yearTable(hist, fallback) {
  const years = [...new Set((hist || []).map((h) => String(h.d).slice(0, 4)))].sort().reverse();
  const visibleYears = ["2026", "2025"].filter((y) => years.includes(y));
  const detailYears = years.filter((y) => !visibleYears.includes(y));
  yearDetailModel = { hist, years, stats: fallback };
  const st = fallback;
  const rows = (hist || []).slice().sort((a,b) => String(a.d).localeCompare(String(b.d)));
  const annualBench = rows.length > 1 ? benchmarkReturn(rows[0].d, rows[rows.length - 1].d, true) : null;
  const allBench = rows.length > 1 ? benchmarkReturn(rows[0].d, rows[rows.length - 1].d, false) : null;
  return `<div class="card" style="margin:12px 16px;padding:16px;border-radius:18px">
    <div class="split"><b>年度收益对比</b>${detailYears.length ? `<button type="button" class="year-detail-btn" onclick="openYearDetails()">历年明细<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3 5 5-5 5"/></svg></button>` : ""}</div>
    <div class="scroll-x"><table class="table">
      <tr><th>时间</th><th>资金加权收益率</th><th>${yearBenchHeader()}</th></tr>
      <tr><td>年化收益率</td><td class="${st.ytd == null ? "faint" : tone(st.ytd)}">${st.ytd == null ? "暂无" : pct(st.ytd)}</td><td class="${annualBench == null ? "faint" : tone(annualBench)}">${annualBench == null ? "暂无" : pct(annualBench)}</td></tr>
      ${visibleYears.map((y) => yearRow(hist, y)).join("")}
      <tr><td>记账以来</td><td class="${st.mwr == null ? "faint" : tone(st.mwr)}">${st.mwr == null ? "暂无" : pct(st.mwr)}</td><td class="${allBench == null ? "faint" : tone(allBench)}">${allBench == null ? "暂无" : pct(allBench)}</td></tr>
    </table></div>
    <div class="faint" style="margin-top:8px;font-size:12px">收益率趋势图可切换主要市场基准指数。</div>
  </div>`;
}
function compose(st, accountId, unit = "元") {
  const canEdit = !!accountId;
  const editing = canEdit && route.editFlow;
  const composeRange = route.composeRange || "all";
  const composeRangeLabel = { all:"记账以来", ytd:"今年", "1y":"近 1 年" }[composeRange];
  const red = "#e55f5c", green = "#2eb789";
  const vc = (n) => (n > 0 ? red : n < 0 ? green : "var(--muted)");
  const f = (label, val, col, row, o) => {
    o = o || {};
    const cls = ["fund-flow-card", o.tone ? "fund-flow-card--" + o.tone : "", o.kind && editing ? "fund-flow-card--edit" : ""].filter(Boolean).join(" ");
    let evt = "";
    if (o.kind) evt = editing ? `onclick="editInvestFlow('${accountId}','${o.kind}')" title="点击修改"` : `ondblclick="editInvestFlow('${accountId}','${o.kind}')" title="双击修改"`;
    return `<div class="${cls}" style="grid-column:${col};grid-row:${row}" ${evt}><span class="fund-flow-label">${label}</span><strong class="fund-flow-value" style="${o.color ? `color:${o.color}` : ""}">${val}</strong></div>`;
  };
  const d1 = st.first ? pretty(st.first) : "--";
  const d2 = st.last ? pretty(st.last) : "--";
  return `<div class="card" style="margin:12px 16px;padding:16px;border-radius:16px">
    <div class="split"><span class="ttl"><b>资产构成${canEdit ? `（${unit}）` : ""}</b>${canEdit ? `<button class="pencil-btn ${editing ? "is-on" : ""}" type="button" onclick="toggleInvestEdit()" title="${editing ? "退出编辑" : "编辑投入 / 转出"}" aria-label="编辑投入转出">${icoPencil()}</button>` : ""}</span><div class="range-select"><button type="button" class="ghost-btn" aria-expanded="${!!route.composeRangeOpen}" onclick="event.stopPropagation();route.composeRangeOpen=!route.composeRangeOpen;render({resize:false,keepScroll:true})">${composeRangeLabel}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m4 6 4 4 4-4"/></svg></button>${route.composeRangeOpen ? `<div class="dd-menu">${[["all","记账以来"],["ytd","今年"],["1y","近 1 年"]].map(([v,l]) => `<button type="button" class="dd-item ${composeRange === v ? "on" : ""}" onclick="event.stopPropagation();setComposeRange('${v}')"><span>${l}</span>${composeRange === v ? `<span class="tick">✓</span>` : ""}</button>`).join("")}</div>` : ""}</div></div>
    <div class="fund-flow-grid">
      <div aria-hidden="true" class="fund-flow-bracket fund-flow-bracket--left"></div>
      <div aria-hidden="true" class="fund-flow-bracket fund-flow-bracket--right"></div>
      <div aria-hidden="true" class="fund-flow-center-line fund-flow-center-line--left"></div>
      <div aria-hidden="true" class="fund-flow-center-line fund-flow-center-line--right"></div>
      ${f("投入", compactSignedNum(st.inAmt), 1, 1, { kind: "in", color: red })}
      ${f("期初金额<br>(" + d1 + ")", "0.00", 2, 1, { tone: "flow", color: "var(--muted)" })}
      ${f("转出", st.outAmt ? "-" + compactNum(st.outAmt) : "0.00", 1, 3, { kind: "out", color: green })}
      ${f("净投入", compactSignedNum(st.net), 2, 2, { tone: "flow", color: vc(st.net) })}
      ${f("期末金额<br>(" + d2 + ")", compactNum(st.amount), 3, 2, { tone: "result" })}
      ${f("收益", compactSignedNum(st.pnl), 2, 3, { tone: "flow", color: vc(st.pnl) })}
    </div>
  </div>`;
}
function icoPencil() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>`;
}
function toggleInvestEdit() {
  route.editFlow = !route.editFlow;
  render({ resize: false });
}
function editInvestFlow(id, kind) {
  const a = S.invest.find((x) => x.id === id);
  if (!a) return;
  const unit = currencyUnit(a.cur);
  const lbl = kind === "in" ? `累计投入（${unit}，正数）` : `累计转出（${unit}，正数）`;
  const cur = kind === "in" ? (Number(a.inAmt) || 0) : (Number(a.outAmt) || 0);
  showModal(modalShell(lbl, "这是记录，按券商收益手动修正该账户的累计投入 / 转出即可，收益会自动更新。", `
    <input id="flowVal" class="modal-input" type="number" value="${cur}" />
    <button class="modal-ok" onclick="saveInvestFlow('${id}','${kind}')">保存</button>`));
}
function saveInvestFlow(id, kind) {
  const a = S.invest.find((x) => x.id === id);
  const v = Number(String((document.getElementById("flowVal") || {}).value || "").replace(/,/g, ""));
  if (!a) return;
  if (!Number.isFinite(v) || v < 0) { closeMask(); toast("请输入有效金额"); return; }
  if (kind === "in") a.inAmt = v; else a.outAmt = v;
  a.flowAdjusted = true;
  captureSnap();
  save();
  closeMask();
  toast("已更新");
  render({ resize: false });
}
function allInvestVirtual() {
  const t = totals();
  const accounts = S.invest.map((a) => ({
    rows: (a.hist || []).slice().sort((x, y) => String(x.d).localeCompare(String(y.d))).map((h) => ({
      d: String(h.d).slice(0, 10), v: (Number(h.v) || 0) * fxRate(a.cur),
      inn: (Number(h.inn) || 0) * fxRate(a.cur), out: (Number(h.out) || 0) * fxRate(a.cur)
    }))
  })).filter((a) => a.rows.length);
  const dates = [...new Set(accounts.flatMap((a) => a.rows.map((h) => h.d)))].sort();
  const firstDate = dates[0] || "";
  const merged = dates.map((d) => {
    let v = 0, inn = 0, out = 0;
    for (const a of accounts) {
      const active = a.rows.filter((h) => h.d <= d);
      if (!active.length) continue;
      const current = active[active.length - 1];
      v += current.v;
      const exact = a.rows.find((h) => h.d === d);
      if (exact) {
        inn += exact.inn; out += exact.out;
        // 后加入汇总的账户，其首日资产是组合新增本金，而不是组合收益。
        if (d !== firstDate && exact === a.rows[0]) inn += exact.v - exact.inn + exact.out;
      }
    }
    return { d, v, inn, out };
  });
  const inAmt = S.invest.reduce((n, a) => n + (a.inAmt || 0) * fxRate(a.cur), 0);
  const outAmt = S.invest.reduce((n, a) => n + (a.outAmt || 0) * fxRate(a.cur), 0);
  const virt = { amount: t.inv, inAmt, outAmt, hist: merged, expected: S.expected };
  const st = investStats(virt);
  st.amount = t.inv;
  st.pnl = t.pnl;
  return { virt, st };
}
function icoGear() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H8.5A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V8.5a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`;
}
function icoShare() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 4v12"/><path d="M7 8l5-5 5 5"/><path d="M5 14v5h14v-5"/></svg>`;
}
function icoLayers() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 8.2 4.6L12 12.2 3.8 7.6Z"/><path d="m3.8 12.3 8.2 4.6 8.2-4.6" opacity=".72"/><path d="m3.8 16.9 8.2 4.6 8.2-4.6" opacity=".45"/></svg>`;
}
function summary() {
  const t = totals();
  const { virt, st } = allInvestVirtual();
  const byBucket = { 活钱: 0, 稳健: 0, 长期: 0 };
  for (const a of S.invest) byBucket[a.bucket || "长期"] += cny(a);
  const parts = Object.entries(byBucket).filter(([, v]) => v);
  return `<section class="screen on gray">
    ${topBar("go('invest')", `<button class="bar-ico" type="button" onclick="copySummary()" aria-label="复制摘要">${icoShare()}</button><button class="bar-ico" type="button" onclick="go('settings')" aria-label="设置">${icoGear()}</button>`)}
    <div class="pad faint" style="margin:4px 0 8px">汇总 / 默认汇总</div>
    <div class="card invest-chart-card" style="margin:0 16px;padding:16px;border-radius:16px">
      <div class="k">总资产 (元) ${hideBtn()}</div>
      <div class="n">${num(t.inv)}</div>
      <div class="metric">
        <div><div class="k">累计收益 (元)</div><b class="${tone(t.pnl)}">${num(t.pnl)}</b></div>
        <div><div class="k"><span>资金加权收益率</span><button class="q" type="button" onclick="event.stopPropagation();openMetricHelp('mwr')" aria-label="了解资金加权收益率">?</button></div><b class="${st.mwr == null ? "faint" : tone(st.mwr)}">${st.mwr == null ? "暂无" : pct(st.mwr)}</b></div>
        <div><div class="k"><span>年化收益率</span><button class="q" type="button" onclick="event.stopPropagation();openMetricHelp('annual')" aria-label="了解年化收益率">?</button></div><b class="${st.ytd == null ? "faint" : tone(st.ytd)}">${st.ytd == null ? "暂无" : pct(st.ytd)}</b></div>
      </div>
      ${chartBlock(virt.hist, S.expected)}
    </div>
    ${yearTable(virt.hist, st)}
    ${compose(st)}
    <div class="card" style="margin:12px 16px;padding:16px;border-radius:16px">
      <b>资产比例</b>
      <div class="ratio-bar">${parts.map(([k, v]) => `<i style="width:${t.inv ? v / t.inv * 100 : 0}%;background:${k === "活钱" ? "#d07a8a" : k === "稳健" ? "#5aa7b8" : "var(--bar)"}"></i>`).join("")}</div>
      ${parts.map(([k, v]) => `<div class="split" style="margin-top:8px"><span>● ${k} ${t.inv ? (v / t.inv * 100).toFixed(1) : "0.0"}%</span><span>¥ ${num(v)}</span></div>`).join("")}
      ${S.invest.map((a) => {
        const p = t.inv ? cny(a) / t.inv * 100 : 0;
        return `<div class="split faint" style="margin-top:8px;padding-left:16px"><span>${esc(a.name)} ${p.toFixed(1)}%</span><span>${money(a.amount, a.cur)}</span></div>`;
      }).join("")}
    </div>
  </section>`;
}
function account() {
  const a = S.invest.find((x) => x.id === route.account);
  if (!a) {
    return `<section class="screen on gray">${navHead("go('invest')", "投资账户")}<div class="w-card faint" style="text-align:center;padding:28px">没有找到这笔投资，或数据仍在同步。</div></section>`;
  }
  const st = investStats(a);
  st.amount = a.amount;
  const unit = currencyUnit(a.cur);
  const hist = route.showAll ? st.hist.slice().reverse() : st.hist.slice().reverse().slice(0, 3);
  return `<section class="screen on gray">
    <div class="account-head">
      <button class="back" type="button" onclick="go('invest')" aria-label="返回">${chevLeft()}</button>
      <div class="account-title">${a.market ? marketIco(a.market, 24) : ""}<span>${esc(a.name)}<small>${esc(a.bucket)}</small></span></div>
      <div class="right"><button class="bar-ico" type="button" onclick="go('settings',{account:'${a.id}'})" aria-label="设置">${icoGear()}</button><button class="bar-ico" type="button" onclick="copySummary('${a.id}')" aria-label="复制摘要">${icoShare()}</button></div>
    </div>
    <div class="card invest-chart-card" style="margin:0 16px;padding:16px;border-radius:16px">
      <div class="split"><span class="k">资产 (${unit}) ${hideBtn()}</span><span class="faint">${daysAgo(a.updated)}</span></div>
      <div class="n">${num(a.amount)}</div>
      <div class="metric">
        <div><div class="k">累计收益</div><b class="${tone(st.pnl)}">${compactSignedNum(st.pnl)}</b></div>
        <div><div class="k"><span>资金加权收益率</span><button class="q" type="button" onclick="event.stopPropagation();openMetricHelp('mwr','${a.id}')" aria-label="了解资金加权收益率">?</button></div><b class="${st.mwr == null ? "faint" : tone(st.mwr)}">${st.mwr == null ? "暂无" : pct(st.mwr)}</b></div>
        <div><div class="k"><span>年化收益率</span><button class="q" type="button" onclick="event.stopPropagation();openMetricHelp('annual','${a.id}')" aria-label="了解年化收益率">?</button></div><b class="${st.ytd == null ? "faint" : tone(st.ytd)}">${st.ytd == null ? "暂无" : pct(st.ytd)}</b></div>
      </div>
      ${chartBlock(st.hist, a.expected || S.expected, unit)}
    </div>
    ${yearTable(st.hist, st)}
    ${compose(st, a.id, unit)}
    <div class="card" style="margin:12px 16px;padding:16px;border-radius:16px">
      <b>更新记录</b>
      <div class="tl" style="margin-top:12px">
        ${hist.length ? hist.map((h) => `<h4>${zhDate(h.d)}</h4><div class="row-card split"><span>当天资产金额</span><b>${Number(h.v).toLocaleString("zh-CN")} ${unit}</b></div>${h.inn || h.out ? `<div class="k" style="margin:-4px 0 10px 8px">投入 ${num(h.inn || 0)} ${unit}　转出 ${num(h.out || 0)} ${unit}</div>` : ""}`).join("") : `<div class="faint" style="text-align:center;padding:20px">暂无更新记录</div>`}
        ${st.hist.length > 3 && !route.showAll ? `<button class="faint" style="display:block;width:100%" onclick="route.showAll=true;render()">查看更多</button>` : ""}
      </div>
    </div>
  </section>`;
}
function settingsPage() {
  const a = route.account ? S.invest.find((x) => x.id === route.account) : null;
  const grp = a ? (a.group || ledgerGroup(String(a.name), a.market)) : null;
  const back = a ? `go('account',{account:'${a.id}'})` : "go('summary')";
  return `<section class="screen on gray">
    ${navHead(back, "设置")}
    ${a ? `<div class="w-card">
      <div class="field"><label>名称</label><input value="${esc(a.name)}" onchange="patchInvest('${a.id}',{name:this.value},false)" /></div>
      <div class="field"><label>市场</label>${marketSelect("setMarketMenu", a.market || "", "pickInvestMarket", a.id)}</div>
      <div class="field"><label>类型</label>
        <div class="types">${["活钱", "稳健", "长期"].map((b) => `<button class="${a.bucket === b ? "on" : ""}" onclick="patchInvest('${a.id}',{bucket:'${b}'})">${b}</button>`).join("")}</div>
      </div>
      <div class="field"><label>币种</label>
        <div class="types">${CURS.map((c) => `<button class="${a.cur === c.code ? "on" : ""}" onclick="patchInvest('${a.id}',{cur:'${c.code}'})">${c.name}</button>`).join("")}</div>
      </div>
      <div class="field"><label>预期年化 %</label><input type="number" value="${a.expected || S.expected}" onchange="patchInvest('${a.id}',{expected:Number(this.value)||0},false)" /></div>
      <div class="account-actions">
        <button class="account-pill archive" onclick="archiveInvest('${a.id}')">${a.archived ? "恢复资产" : "归档资产"}</button>
        <button class="account-pill delete" onclick="removeItem('invest','${a.id}')">删除</button>
      </div>
    </div>
    ${grp ? `<div class="w-card">
      <div class="field"><label>账本导入 / 导出</label>
        <div class="types"><button class="ghost-btn" onclick="exportXlsxForGroup('${String(grp).replace(/'/g,"\\'")}')">导出 Excel</button><button class="ghost-btn" onclick="exportBookForGroup('${String(grp).replace(/'/g,"\\'")}')">导出 JSON</button><button class="ghost-btn" onclick="importLedgerToGroup('${String(grp).replace(/'/g,"\\'")}')">导入到该账本</button></div>
      </div>
    </div>` : ""}` : `<div class="w-card">
      <div class="field"><label>默认预期年化 %</label><input type="number" value="${S.expected}" onchange="S.expected=Number(this.value)||0;save();" /></div>
    </div>`}
  </section>`;
}

let calState = { open: false, id: "", month: null, max: "", selected: "" };
function datePickerHTML(id, value, max) {
  const maxDay = max || today();
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  return `<div class="cal">
    <input type="hidden" id="${id}" value="${esc(selected)}" data-max="${esc(maxDay)}" />
    <button type="button" class="cal-btn${selected ? "" : " is-empty"}" id="${id}Btn" onclick="event.stopPropagation();toggleCal('${id}')">
      <span class="cal-val" id="${id}Val">${selected ? selected.replaceAll("-", "/") : "选择日期"}</span>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v3M17 3v3M4 9h16"/><rect x="4" y="5" width="16" height="16" rx="3"/></svg>
    </button>
    <div class="cal-pop" id="${id}Pop" hidden></div>
  </div>`;
}
function closeCal() {
  document.querySelectorAll(".cal-pop").forEach((el) => { el.hidden = true; el.innerHTML = ""; });
  document.querySelectorAll(".cal-btn").forEach((el) => el.classList.remove("on"));
  calState.open = false;
}
function toggleCal(id) {
  const pop = document.getElementById(id + "Pop");
  const btn = document.getElementById(id + "Btn");
  const input = document.getElementById(id);
  if (!pop || !btn || !input) return;
  if (calState.open && calState.id === id) { closeCal(); return; }
  closeCal();
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(input.value) ? input.value : (input.getAttribute("data-max") || today());
  const [y, m] = selected.split("-").map(Number);
  calState = { open: true, id, month: new Date(y, m - 1, 1), max: input.getAttribute("data-max") || today(), selected: input.value };
  btn.classList.add("on");
  pop.hidden = false;
  renderCal();
}
function calMonth(delta) {
  if (!calState.open) return;
  calState.month = new Date(calState.month.getFullYear(), calState.month.getMonth() + delta, 1);
  renderCal();
}
function pickCal(date) {
  const id = calState.id;
  const input = document.getElementById(id);
  const val = document.getElementById(id + "Val");
  const btn = document.getElementById(id + "Btn");
  if (input) input.value = date;
  if (val) val.textContent = date.replaceAll("-", "/");
  if (btn) btn.classList.remove("is-empty");
  closeCal();
}
function calToday() { pickCal(today()); }
function renderCal() {
  const pop = document.getElementById(calState.id + "Pop");
  if (!pop || !calState.open) return;
  const year = calState.month.getFullYear();
  const mon = calState.month.getMonth();
  const firstOffset = (new Date(year, mon, 1).getDay() + 6) % 7;
  const days = new Date(year, mon + 1, 0).getDate();
  const iso = (day) => year + "-" + pad(mon + 1) + "-" + pad(day);
  const max = calState.max;
  const selected = calState.selected;
  const now = today();
  const atLatest = year + "-" + pad(mon + 1) >= String(max).slice(0, 7);
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const day = i - firstOffset + 1;
    if (day < 1 || day > days) { cells += "<span></span>"; continue; }
    const date = iso(day);
    const disabled = date > max;
    const on = date === selected;
    const isToday = date === now;
    cells += `<button type="button" ${disabled ? "disabled" : ""} class="${[on ? "on" : "", disabled ? "mute" : ""].filter(Boolean).join(" ")}" onclick="${disabled ? "" : `pickCal('${date}')`}">${day}${isToday && !on ? '<i class="dot"></i>' : ""}</button>`;
  }
  pop.innerHTML = `<div class="cal-nav">
      <button type="button" onclick="event.stopPropagation();calMonth(-1)" aria-label="上个月">‹</button>
      <strong>${year} 年 ${mon + 1} 月</strong>
      <button type="button" ${atLatest ? "disabled" : ""} onclick="event.stopPropagation();calMonth(1)" aria-label="下个月">›</button>
    </div>
    <div class="cal-week">${["一","二","三","四","五","六","日"].map((d) => `<span>${d}</span>`).join("")}</div>
    <div class="cal-days">${cells}</div>
    <div class="cal-foot"><span>未来日期不可选择</span><button type="button" onclick="event.stopPropagation();calToday()">回到今天</button></div>`;
}
function openUpdate(id, opts) {
  const a = S.invest.find((x) => x.id === id);
  if (!a) { toast("找不到该资产"); return; }
  updateTarget = id;
  route.dlg = "update";
  route.dlgTarget = id;
  route.updateFlow = !!route.updateFlow;
  if (!opts || !opts.skipUrl) syncUrl(false);
  const when = a.updated ? md(a.updated) : "上次";
  const meta = curMeta(a.cur);
  const unit = currencyUnit(a.cur);
  const flow = !!route.updateFlow;
  showModal(modalShell("更新收益", `上次更新（${when}）至今，记下市值变化；有资金进出时一并登记投入或转出。`, `
    <div>
      <span class="modal-lab">资金进出</span>
      <div class="modal-seg">
        <button type="button" class="${flow ? "on" : ""}" onclick="setUpdateFlow(true)">有资金进出</button>
        <button type="button" class="${flow ? "" : "on"}" onclick="setUpdateFlow(false)">没有资金进出</button>
      </div>
    </div>
    <div class="flow-grid" id="flowFields" style="display:${flow ? "grid" : "none"}">
      <div><span class="modal-lab">投入（${unit}）</span><input id="inAmt" class="modal-input" inputmode="decimal" placeholder="可空" oninput="syncUpdateHint()" /></div>
      <div><span class="modal-lab">转出（${unit}）</span><input id="outAmt" class="modal-input" inputmode="decimal" placeholder="可空" oninput="syncUpdateHint()" /></div>
    </div>
    <div>
      <span class="modal-lab" style="display:flex;justify-content:space-between"><span>当前资产金额</span><span>${meta.name} · ${a.cur}</span></span>
      ${amtField("newAmt", "", a.cur)}
      <div class="modal-hint" aria-live="polite">
        <span id="updHint">现有市值 ${num(a.amount)} ${unit}</span>
        <span>记账后 <b id="updAfter">${num(a.amount)} ${unit}</b></span>
      </div>
    </div>
    <div>
      <span class="modal-lab">记账日期</span>
      ${datePickerHTML("updDate", today(), today())}
    </div>
  `, `<button type="button" class="modal-cancel" onclick="closeMask()">取消</button>
     <button type="button" class="modal-ok" onclick="commitUpdate()">确认记录</button>`));
  paintAmt("newAmt", false);
  const el = document.getElementById("newAmt");
  if (el) el.focus();
}
function setUpdateFlow(on) {
  closeCal();
  route.updateFlow = !!on;
  const extra = document.getElementById("flowFields");
  if (extra) extra.style.display = on ? "grid" : "none";
  document.querySelectorAll(".modal-seg button").forEach((b, i) => b.classList.toggle("on", on ? i === 0 : i === 1));
  syncUpdateHint();
}
function syncUpdateHint() {
  const a = S.invest.find((x) => x.id === updateTarget);
  const hint = document.getElementById("updHint");
  const after = document.getElementById("updAfter");
  if (!a || !hint || !after) return;
  const v = amtNumber("newAmt");
  const valid = Number.isFinite(v);
  hint.textContent = valid ? "现有市值将更新为新金额" : "请输入当前资产金额";
  hint.style.color = valid ? "" : "var(--red)";
  after.textContent = valid ? num(v) + " " + currencyUnit(a.cur) : "—";
}
function commitUpdate() {
  const a = S.invest.find((x) => x.id === updateTarget);
  if (!a) return;
  const v = amtNumber("newAmt");
  if (!Number.isFinite(v)) { toast("请输入金额"); return; }
  const hasFlow = !!route.updateFlow;
  let inn = 0, out = 0;
  if (hasFlow) {
    inn = Number(String((document.getElementById("inAmt") || {}).value || "").replace(/,/g, "")) || 0;
    out = Number(String((document.getElementById("outAmt") || {}).value || "").replace(/,/g, "")) || 0;
    a.inAmt = (a.inAmt || 0) + inn;
    a.outAmt = (a.outAmt || 0) + out;
  }
  const day = (document.getElementById("updDate") && document.getElementById("updDate").value) || today();
  a.amount = v;
  a.updated = day;
  a.hist = [...(a.hist || []), { d: day, v, inn, out }];
  addLog("invest", a);
  captureSnap();
  save();
  route.updateFlow = false;
  closeMask();
  toast("已记下");
  render();
}
function closeMask(opts) {
  closeCal();
  const m = document.getElementById("mask");
  if (!m) return;
  m.className = "mask";
  m.innerHTML = "";
  if (route.dlg) {
    route.dlg = null;
    route.dlgTarget = null;
    if (!opts || !opts.silent) syncUrl(false);
  }
}
function copySummary(id) {
  const a = id ? S.invest.find((x) => x.id === id) : null;
  const t = totals();
  const st = a ? investStats(a) : allInvestVirtual().st;
  const name = a ? a.name : "默认汇总";
  const unit = a ? currencyUnit(a.cur) : "元";
  const amt = a ? a.amount : t.inv;
  const text = name + "\n资产 " + num(amt) + " " + unit + "\n累计收益 " + num(a ? st.pnl : t.pnl) + " " + unit + "\n年化 " + (st.ytd == null ? "暂无" : pct(st.ytd));
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast("已复制摘要")).catch(() => toast(text));
  else toast("已准备摘要");
}
function openReminder(opts) {
  route.dlg = "reminder";
  if (!opts || !opts.skipUrl) syncUrl(false);
  showModal(modalShell("记账提醒", "每月几号提醒自己更新投资市值，填 0 即关闭。", `
    <div>
      <span class="modal-lab">每月日期</span>
      <input id="remDay" class="modal-input" type="number" min="0" max="28" value="${S.reminder || 0}" />
    </div>
  `, `<button type="button" class="modal-cancel" onclick="closeMask()">取消</button>
     <button type="button" class="modal-ok" onclick="S.reminder=Math.max(0,Math.min(28,Number(document.getElementById('remDay').value)||0));save();closeMask();toast(S.reminder?'已设每月'+S.reminder+'日':'已关闭提醒');render()">保存</button>`));
  const el = document.getElementById("remDay");
  if (el) el.focus();
}
function openCustomRange(opts) {
  route.dlg = "custom";
  if (!opts || !opts.skipUrl) syncUrl(false);
  showModal(modalShell("自定义时间段", "按起止日期查看收益率曲线。", `
    <div class="custom-presets"><button type="button" onclick="setCustomPreset('6m')">近半年</button><button type="button" onclick="setCustomPreset('3y')">近 3 年</button><button type="button" onclick="setCustomPreset('5y')">近 5 年</button></div>
    <div>
      <span class="modal-lab">开始日期</span>
      ${datePickerHTML("fromD", route.from || "", today())}
    </div>
    <div>
      <span class="modal-lab">结束日期</span>
      ${datePickerHTML("toD", route.to || today(), today())}
    </div>
  `, `<button type="button" class="modal-cancel" onclick="closeMask()">取消</button>
     <button type="button" class="modal-ok" onclick="route.from=document.getElementById('fromD').value;route.to=document.getElementById('toD').value;route.chartRange='custom';try{localStorage.setItem('fire:chart-range','custom')}catch{};closeMask();render()">查看</button>`));
}
function setCustomPreset(preset) {
  const end = new Date();
  const start = new Date(end);
  if (preset === "6m") start.setMonth(start.getMonth() - 6);
  else start.setFullYear(start.getFullYear() - Number(preset.replace("y", "")));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  [["fromD", iso(start)], ["toD", iso(end)]].forEach(([id, value]) => {
    const input = document.getElementById(id), label = document.getElementById(id + "Val"), btn = document.getElementById(id + "Btn");
    if (input) input.value = value;
    if (label) label.textContent = value.replaceAll("-", "/");
    if (btn) btn.classList.remove("is-empty");
  });
}
function restoreDlg() {
  const d = route.dlg;
  if (d === "update" && (route.dlgTarget || updateTarget)) openUpdate(route.dlgTarget || updateTarget, { skipUrl: true });
  else if (d === "member") addMemberDlg({ skipUrl: true });
  else if (d === "reminder") openReminder({ skipUrl: true });
  else if (d === "custom") openCustomRange({ skipUrl: true });
}
function fillExample(name) {
  route.draft = { ...(route.draft || { amount: "", bucket: "长期", cur: "CNY", expected: S.expected, market: "CN" }), name };
  render();
  const el = document.getElementById("invName");
  if (el) el.focus();
}
function draftField(key, value) {
  route.draft = { name: "", amount: "", bucket: "长期", cur: "CNY", expected: S.expected, market: "CN", ...(route.draft || {}), [key]: value };
  if (key === "name" || key === "amount") {
    const btn = document.querySelector(".ok-btn");
    const d = route.draft;
    const ready = d.name.trim() && d.amount !== "" && Number.isFinite(Number(d.amount));
    if (btn) { btn.classList.toggle("ready", ready); btn.disabled = !ready; }
    return;
  }
  render();
}
function commitInvest() {
  const d = route.draft || {};
  const amount = Number(d.amount);
  if (!d.name || !Number.isFinite(amount)) return;
  const item = {
    id: uid(), name: d.name.trim(), cur: d.cur || marketCur(d.market) || "CNY", amount, bucket: d.bucket || "长期",
    market: d.market || "CN", owner: currentOwner(), inAmt: amount, outAmt: 0, updated: today(), expected: Number(d.expected) || S.expected,
    hist: [{ d: today(), v: amount, inn: amount, out: 0 }]
  };
  S.invest.push(item);
  addLog("invest", item);
  captureSnap();
  save();
  route.draft = null;
  go("invest");
}
function exportBook(invest) {
  const data = Array.isArray(invest) ? { ...S, invest } : S;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "fire-simple-" + today() + ".json";
  a.click();
  toast("已导出简化版账本");
}
async function exportXlsx(invest) {
  const list = Array.isArray(invest) ? invest : (Array.isArray(S.invest) ? S.invest : []);
  if (!list.length) { toast("暂无投资账户可导出"); return; }
  toast("正在导出 Excel…");
  try {
    const r = await fetch("/api/simple-app/tool/export", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invest: list })
    });
    if (!r.ok) { const j = await r.json().catch(() => null); toast((j && j.error) || "导出失败"); return; }
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fire-simple-invest-" + today() + ".xlsx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("已导出 Excel（有知有行格式）");
  } catch { toast("导出失败"); }
}
function exportBookForGroup(group) {
  const invest = S.invest.filter((x) => x.group === group);
  if (!invest.length) { toast("该账本暂无账户"); return; }
  exportBook(invest);
}
function exportXlsxForGroup(group) {
  const invest = S.invest.filter((x) => x.group === group);
  if (!invest.length) { toast("该账本暂无账户"); return; }
  exportXlsx(invest);
}
function importLedgerToGroup(group) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".xlsx,.xls,.json,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const lower = String(file.name || "").toLowerCase();
    if (lower.endsWith(".json")) {
      const reader = new FileReader();
      reader.onload = () => {
        let j = null;
        try { j = JSON.parse(String(reader.result)); } catch { toast("文件无法识别"); return; }
        const invest = Array.isArray(j) ? j : (j && Array.isArray(j.invest)) ? j.invest : null;
        if (invest) { const n = mergeInvest(invest, file.name, group); toast(n ? `已导入 ${n} 个投资到「${group}」` : "没有新增（账户已在该账本）"); }
        else applyImportJson(String(reader.result), file.name);
      };
      reader.readAsText(file);
      return;
    }
    toast("正在导入 Excel…");
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch("/api/simple-app/tool/import", { method: "POST", body: fd });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) { toast((j && j.error) || "导入失败"); return; }
      const n = mergeInvest(Array.isArray(j.invest) ? j.invest : [], file.name, group);
      toast(n ? `已导入 ${n} 个投资到「${group}」` : "没有新增（账户已在该账本或无数据）");
    } catch { toast("导入失败"); }
  };
  inp.click();
}
function applyImportJson(text, fileName) {
  try {
    const data = JSON.parse(String(text));
    if (data && (data.market || data.code || Array.isArray(data.records) || data.holdings)) {
      toast("这是完整版数据，未导入");
      return;
    }
    S = normalize(data);
    applyLedgerRules(fileName);
    captureSnap();
    save();
    render({ resize: false });
    toast("已导入简化版账本");
  } catch { toast("文件无法识别"); }
}
function importBook() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "application/json";
  inp.onchange = () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => applyImportJson(String(reader.result), file.name);
    reader.readAsText(file);
  };
  inp.click();
}
function mergeInvest(list, fileName, groupName) {
  let added = 0, merged = 0, changed = false;
  for (const a of list || []) {
    if (!a || !a.name) continue;
    const name = String(a.name).trim();
    let ex = groupName
      ? S.invest.find((x) => x.group === groupName && x.name === name)
      : S.invest.find((x) => x.name === name);
    if (!ex && !groupName) {
      // 同账本组去重：有知有行的「长桥（美股）」与你已有的「美股（长桥）」都命中关键词「长桥」，
      // 视为同一账户，合并历史、不再新建，避免同组里两个同款。
      const g = ledgerGroup(name, a.market, fileName);
      if (g) ex = S.invest.find((x) => ledgerGroup(String(x.name), x.market || a.market, fileName) === g);
    }
    if (ex) { if (mergeLedgerAccount(ex, a)) merged++; continue; }
    S.invest.push({
      id: uid(), name, cur: a.cur || "CNY", bucket: a.bucket || "长期",
      market: a.market || "CN", owner: currentOwner(), amount: Number(a.amount) || 0,
      inAmt: Number(a.inAmt) || 0, outAmt: Number(a.outAmt) || 0, updated: String(a.updated || today()).slice(0, 10),
      expected: Number(a.expected) || S.expected, hist: Array.isArray(a.hist) ? a.hist : [],
      group: groupName || undefined
    });
    added++;
  }
  if (!groupName && applyLedgerRules(fileName)) changed = true;
  if (!groupName && dedupeInvestGroups()) changed = true;
  if (added || merged || changed) { captureSnap(); save(); render({ resize: false }); }
  return added;
}
// 合并同一账本组里的重复账户（同关键词 = 同账户），保留首个、其余历史并入，清理历史导入产生的重复
function dedupeInvestGroups() {
  let changed = false;
  const out = [];
  for (const a of S.invest) {
    const g = a.group || ledgerGroup(String(a.name), a.market);
    if (!g) { out.push(a); continue; }
    const holder = out.find((x) => (x.group || ledgerGroup(String(x.name), x.market)) === g);
    if (holder) {
      // 同组重复：保留与「账本组名」完全一致的规范账户（如 美股（长桥），因账本组名就是它），
      // 删掉其它写法（如 长桥（美股））；不写死任何固定市场/名称规则，按每个用户的实际账本名来。
      const holderMatches = String(holder.name).toLowerCase() === String(g).toLowerCase();
      const aMatches = String(a.name).toLowerCase() === String(g).toLowerCase();
      if (aMatches && !holderMatches) { out[out.indexOf(holder)] = a; mergeLedgerAccount(a, holder); }
      else mergeLedgerAccount(holder, a);
      changed = true;
    } else out.push(a);
  }
  if (changed) S.invest = out;
  return changed;
}
// 同名账户合并：把导入的历史（每日总资产 / 转入转出）并入现有账户，按日期去重（导入优先）
function mergeLedgerAccount(ex, a) {
  const map = new Map();
  for (const h of ex.hist || []) { const d = String(h.d || "").slice(0, 10); if (d) map.set(d, { d, v: h.v, inn: Number(h.inn) || 0, out: Number(h.out) || 0 }); }
  let hasNew = false;
  for (const h of a.hist || []) {
    const d = String(h.d || "").slice(0, 10);
    if (!d) continue;
    if (!map.has(d)) hasNew = true;
    map.set(d, { d, v: h.v, inn: Number(h.inn) || 0, out: Number(h.out) || 0 });
  }
  const meta = Number(a.amount) || Number(a.inAmt) || Number(a.outAmt) || Number(a.expected);
  if (!hasNew && !meta) return false;
  const hist = cleanImportedHist([...map.values()]);
  ex.hist = hist;
  const last = hist[hist.length - 1];
  if (last && last.v != null) ex.amount = Number(last.v) || ex.amount;
  // 只有用户明确手动修正过才保留；否则用重新导入的源数据纠正旧版漏算的初始本金。
  if (!ex.flowAdjusted) {
    ex.inAmt = Number(a.inAmt) || 0;
    ex.outAmt = Number(a.outAmt) || 0;
  }
  ex.updated = (last && last.d) || String(a.updated || "").slice(0, 10) || ex.updated || today();
  if (Number(a.expected)) ex.expected = Number(a.expected);
  if (a.bucket) ex.bucket = a.bucket;
  if (a.market) ex.market = a.market;
  if (a.cur) ex.cur = a.cur;
  return true;
}
function importLedger() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".xlsx,.xls,.json,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const lower = String(file.name || "").toLowerCase();
    if (lower.endsWith(".json")) {
      const reader = new FileReader();
      reader.onload = () => applyImportJson(String(reader.result), file.name);
      reader.readAsText(file);
      return;
    }
    toast("正在导入 Excel…");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/simple-app/tool/import", { method: "POST", body: fd });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) { toast((j && j.error) || "导入失败"); return; }
      const list = Array.isArray(j.invest) ? j.invest : [];
      const n = mergeInvest(list, file.name);
      toast(n ? `已导入 ${n} 个投资账户` : "没有新增（账户名已存在或无数据）");
    } catch { toast("导入失败"); }
  };
  inp.click();
}

function toggleTheme() {
  const next = !document.documentElement.classList.contains("dark");
  document.documentElement.classList.toggle("dark", next);
  localStorage.setItem("fire-simple-theme", next ? "dark" : "light");
}

const WIN_KEY = "fire-simple-win";
const winEl = document.getElementById("win");
let winState = { x: 24, y: 24, w: 680, h: 0, fixed: false };
try {
  const saved = JSON.parse(localStorage.getItem(WIN_KEY) || "null");
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    winState = { ...winState, ...saved, h: Number.isFinite(saved.h) ? saved.h : 0 };
    const viewportChanged = saved.layoutVersion !== 3 || !Number.isFinite(saved.vw) || Math.abs(saved.vw - window.innerWidth) > 48;
    if (viewportChanged) {
      const enteringDesktop = window.innerWidth >= 1100 && (saved.layoutVersion !== 3 || !Number.isFinite(saved.vw) || saved.vw < 1100);
      const nextW = enteringDesktop ? Math.min(1040, window.innerWidth - 64) : Math.min(winState.w, Math.max(360, window.innerWidth - 16));
      const savedW = Number.isFinite(saved.w) ? saved.w : winState.w;
      const oldCenterRatio = Number.isFinite(saved.vw) && saved.vw > 0
        ? Math.min(1, Math.max(0, (saved.x + savedW / 2) / saved.vw))
        : .5;
      const edge = window.innerWidth <= 376 ? 0 : 8;
      winState.w = nextW;
      winState.h = enteringDesktop ? 0 : winState.h;
      winState.x = Math.max(edge, Math.min(window.innerWidth - nextW - edge, Math.round(window.innerWidth * oldCenterRatio - nextW / 2)));
      winState.y = Math.max(8, Math.min(winState.y, window.innerHeight - 80));
    }
  } else if (window.innerWidth >= 1100) {
    winState.w = Math.min(1040, window.innerWidth - 64);
    winState.x = Math.round((window.innerWidth - winState.w) / 2);
  }
  saveWin();
  document.documentElement.style.setProperty("--saved-win-w", winState.w + "px");
} catch {}
function pageMinW() { return 360; }
function displayW() { return Math.max(winState.w, pageMinW()); }
function saveWin() {
  try {
    localStorage.setItem(WIN_KEY, JSON.stringify({
      x: winState.x, y: winState.y, w: winState.w, h: winState.h, fixed: winState.fixed,
      vw: window.innerWidth, vh: window.innerHeight, layoutVersion: 3
    }));
  } catch {}
}
let _syncToken = 0;
function syncScroll() {
  const body = document.getElementById("app");
  if (!body) return;
  const token = ++_syncToken;
  requestAnimationFrame(() => {
    if (token !== _syncToken) return;          // 已有更新的调用，放弃本次
    if (body.scrollHeight <= body.clientHeight + 8) body.scrollTop = 0;
  });
}
function applyWin() {
  if (window.matchMedia("(max-width: 760px) and (pointer: coarse)").matches) {
    winEl.style.transform = "none";
    winEl.style.width = "100%";
    winEl.style.height = "100dvh";
    winEl.classList.toggle("is-fixed", true);
    syncScroll();
    return;
  }
  const maxW = Math.max(360, window.innerWidth - 16);
  const maxH = Math.max(320, window.innerHeight - 48);
  const width = Math.min(displayW(), maxW);
  let x = winState.x, y = winState.y;
  if (x + width > window.innerWidth) x = Math.max(0, window.innerWidth - width - 8);
  if (y > window.innerHeight - 80) y = Math.max(0, window.innerHeight - 80);
  winEl.style.transform = `translate(${x}px, ${y}px)`;
  winEl.style.width = width + "px";
  winEl.style.height = winState.h ? Math.min(winState.h, maxH) + "px" : "auto";
  winEl.classList.toggle("is-fixed", winState.fixed);
  const pin = document.getElementById("pinBtn");
  if (pin) {
    pin.classList.toggle("is-on", winState.fixed);
    pin.title = winState.fixed ? "已固定窗口（点击解锁拖动）" : "固定窗口（锁定当前位置）";
    const svg = pin.querySelector("svg");
    if (svg) svg.setAttribute("fill", winState.fixed ? "currentColor" : "none");
  }
  requestAnimationFrame(() => {
    if (!winState.h) {
      const h = winEl.getBoundingClientRect().height;
      if (h > maxH + 1) winEl.style.height = maxH + "px";
    }
    syncScroll();
  });
}
function togglePin() { winState.fixed = !winState.fixed; saveWin(); applyWin(); }

let drag = null;
document.getElementById("winBar").addEventListener("pointerdown", (e) => {
  if (winState.fixed) return;
  if (e.target.closest("button")) return;
  e.preventDefault();
  drag = { kind: "move", x: e.clientX, y: e.clientY, bx: winState.x, by: winState.y };
  winEl.setPointerCapture(e.pointerId);
});
winEl.querySelectorAll(".handle").forEach((h) => {
  h.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = winEl.getBoundingClientRect();
    drag = { kind: "resize", dir: h.dataset.dir, x: e.clientX, y: e.clientY, bx: winState.x, by: winState.y, bw: r.width, bh: r.height };
    winEl.setPointerCapture(e.pointerId);
  });
});
window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (drag.kind === "move") {
    winState.x = Math.max(0, drag.bx + dx);
    winState.y = Math.max(0, drag.by + dy);
  } else {
    const minW = 360;
    const minH = 320;
    let { bx, by, bw, bh, dir } = drag;
    if (dir.includes("e")) winState.w = Math.max(minW, bw + dx);
    if (dir.includes("s")) winState.h = Math.max(minH, bh + dy);
    if (dir.includes("w")) {
      const w = Math.max(minW, bw - dx);
      winState.x = bx + (bw - w);
      winState.w = w;
    }
    if (dir.includes("n")) {
      const h = Math.max(minH, bh - dy);
      winState.y = Math.max(0, by + (bh - h));
      winState.h = h;
    }
  }
  applyWin();
  // 拖拽过程中持续落盘，避免页面切换或指针被接管时丢失最后尺寸
  saveWin();
});
window.addEventListener("pointerup", () => { if (!drag) return; drag = null; saveWin(); });
window.addEventListener("pointercancel", () => { if (!drag) return; drag = null; saveWin(); });
window.addEventListener("resize", applyWin);
window.addEventListener("storage", (e) => {
  if (e.key !== WIN_KEY || !e.newValue) return;
  try {
    const next = JSON.parse(e.newValue);
    if (!next || !Number.isFinite(next.w)) return;
    winState = { ...winState, ...next, h: Number.isFinite(next.h) ? next.h : winState.h };
    applyWin();
  } catch {}
});

function setFoot(html, gray) {
  const f = document.getElementById("foot");
  const win = document.getElementById("win");
  if (!f) return;
  f.innerHTML = html || "";
  f.classList.toggle("on", Boolean(html));
  if (win) win.classList.toggle("gray-dock", Boolean(gray));
}
function cycleInvFilter() {
  setInvFilter(INV_FILTERS[(INV_FILTERS.indexOf(route.invFilter || "全部资产") + 1) % INV_FILTERS.length]);
}
function setComposeRange(value) {
  route.composeRange = value;
  route.composeRangeOpen = false;
  render({ resize: false, keepScroll: true });
}
function render(opts) {
  opts = opts || {};
  // 每次渲染前自动打组 + 合并同一账本组里的重复账户（如 美股（ibkr）与 ibkr），合并后无重复、只发生一次
  if (applyLedgerRules()) save();
  if (dedupeInvestGroups()) save();
  // 页面重渲染时强制收起桑基图全屏覆盖层，避免其在任意页面残留成“向下拉的条框”
  closeSankey();
  const map = {
    home, weather: weatherPage, cashflow: cashflowPage, family, calendar: calendarPage, manage: managePage,
    update: updateFamily, addItem: addItemPage, editItem: editItemPage, help: helpPage,
    invest: investHome, addInvest: addInvestPage, summary, addSummary: addSummaryPage, account, settings: settingsPage
  };
  let html;
  try {
    html = (map[route.name] || home)();
  } catch (err) {
    console.error(err);
    toast("页面出错，已回到总览");
    route.name = "home";
    html = home();
  }
  document.getElementById("app").innerHTML = html;
  if (["account", "summary"].includes(route.name)) requestAnimationFrame(() => ensureBenchmark(false));
  const body = document.getElementById("app");
  if (body && opts.keepScroll !== true) body.scrollTop = 0;
  if (route.name === "family") {
    setFoot(`<button class="cta" type="button" onclick="go('update',{cat:'cash'})">更新资产</button>`, true);
  } else if (route.name === "account" && route.account) {
    setFoot(`<button class="cta" type="button" onclick="openUpdate('${route.account}')">更新收益</button>`, true);
  } else if (route.name === "update") {
    const idx = CATS.findIndex((c) => c.id === route.cat);
    const next = idx >= 0 && idx < CATS.length - 1 ? `go('update',{cat:'${CATS[idx + 1].id}'})` : "finishUpdate()";
    setFoot(`<button class="fab" type="button" onclick="${next}">→</button>`, false);
  } else {
    setFoot("");
  }
  // 每次换页都重新应用全局窗口尺寸；resize:false 只表示不触发额外的尺寸测量，不能让页面沿用旧布局
  applyWin();
  syncScroll(); // 内容变化后立即校正内容区滚动条显隐，避免刷新/切页闪现
  if (!opts.skipUrl) syncUrl(!!opts.pushUrl);
}
window.addEventListener("popstate", () => {
  urlLock = true;
  closeSankey();
  closeDrop();
  closeMask({ silent: true });
  route = { name: "home", cat: "cash", member: "全部", chartKind: "mwr", chartRange: "all", showAll: false, showArchived: false, investSort: "updated", sortMenu: false, impMenu: false, editFlow: false, groupMenu: null, accMenu: false };
  updateTarget = null;
  readUrl();
  render({ skipUrl: true, keepScroll: false });
  restoreDlg();
  urlLock = false;
});
document.addEventListener("pointerdown", (e) => {
  if (calState.open && !e.target.closest(".cal-pop") && !e.target.closest(".cal-btn")) closeCal();
  if (!e.target.closest(".dd")) closeDrop();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (calState.open) { closeCal(); return; }
  const openDd = document.querySelector(".dd-menu:not([hidden])");
  if (openDd) { closeDrop(); return; }
  const sk = document.getElementById("skFull");
  if (sk && sk.classList.contains("on")) { closeSankey(); return; }
  const m = document.getElementById("mask");
  if (m && m.classList.contains("on")) { closeMask(); return; }
});

if (localStorage.getItem("fire-simple-theme") === "dark") document.documentElement.classList.add("dark");
readUrl();
loadMarketIcons();
render({ skipUrl: true });
applyWin();
document.documentElement.classList.add("simple-app-ready");
if (window.ResizeObserver) {
  const appEl = document.getElementById("app");
  if (appEl) new ResizeObserver(() => syncScroll()).observe(appEl);
}
restoreDlg();
hydrate();
window.remountSimpleApp = function remountSimpleApp() {
  readUrl();
  loadMarketIcons();
  render({ skipUrl: true });
  applyWin();
  document.documentElement.classList.add("simple-app-ready");
  restoreDlg();
  hydrate();
};
