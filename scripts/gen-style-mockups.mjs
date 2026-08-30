/* 生成 8 个设置风格预览 HTML（public/mockups/），每款含 浅色/深色 切换 */
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public", "mockups");

const CONTENT = `
        <div class="group">
          <div class="group-title">站点信息</div>
          <div class="rows">
            <div class="row"><div class="row-label"><b>网站标题</b></div><input class="input" value="Fire - 股票记录与持仓管理" /></div>
            <div class="row"><div class="row-label"><b>网站域名</b></div><input class="input" value="fire.example.com" /></div>
            <div class="row"><div class="row-label"><b>页脚简介文字</b></div><input class="input" value="一个轻量、免费的股票记录网站" /></div>
            <div class="row"><div class="row-label"><b>允许新用户注册</b><span>关闭后仅管理员可创建账号</span></div><div class="switch on"></div></div>
          </div>
        </div>
        <div class="group">
          <div class="group-title">网站形象</div>
          <div class="rows">
            <div class="row"><div class="row-label"><b>网站图标</b></div><input class="input" value="/uploads/ico/fire.png" /></div>
            <div class="row"><div class="row-label"><b>Logo</b></div><input class="input" value="/uploads/logo/fire.png" /></div>
            <div class="row"><div class="row-label"><b>Logo 文字</b></div><input class="input" value="Fire" /></div>
            <div class="row">
              <div class="row-label"><b>Logo 字体</b></div>
              <div class="pills"><button class="pill active">KIRO 粗体</button><button class="pill">KIRO 常规</button><button class="pill">系统</button></div>
            </div>
            <div class="row"><div class="row-label"><b>预览</b></div><span class="font-preview">Fire</span></div>
            <div class="row"><div class="row-label"><b>恢复默认形象</b><span>清空图标 / Logo / 背景</span></div><button class="btn">重置</button></div>
          </div>
        </div>
        <div class="group">
          <div class="group-title">交易 · 富途 OpenAPI</div>
          <div class="rows">
            <div class="row"><div class="row-label"><b>OpenD 主机</b></div><input class="input" value="localhost" /></div>
            <div class="row"><div class="row-label"><b>端口</b></div><input class="input" value="11111" /></div>
            <div class="row">
              <div class="row-label"><b>连接状态</b></div>
              <div class="ctrl"><span class="status"><span class="dot"></span>已连接 · AAPL 305.59</span><button class="btn">测试连接</button></div>
            </div>
            <div class="row">
              <div class="row-label"><b>行情源</b></div>
              <div class="pills"><button class="pill active">自动（富途优先）</button><button class="pill">仅富途</button><button class="pill">腾讯 + Yahoo</button></div>
            </div>
            <div class="row"><div class="row-label"><span>自动模式：富途在线走富途，失败回退腾讯 + Yahoo</span></div></div>
          </div>
        </div>
        <div class="group">
          <div class="group-title">数据库</div>
          <div class="rows">
            <div class="row"><div class="row-label"><b>PostgreSQL 连接</b><span>db.example.com:5432 · 可选</span></div><button class="btn">测试连接</button></div>
          </div>
        </div>`;

const SIDEBAR = `
      <aside class="sidebar">
        <div class="side-logo"><span class="mark">F</span><b>Fire</b></div>
        <button class="search-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>搜索设置</button>
        <div class="nav-group">
          <div class="nav-group-title">网站</div>
          <div class="nav-item active">网站设置</div>
          <div class="nav-item">网站形象</div>
        </div>
        <div class="nav-group">
          <div class="nav-group-title">股票</div>
          <div class="nav-item">股票来源接口</div>
          <div class="nav-item">交易 · 富途 <span class="badge">已连接</span></div>
        </div>
        <div class="nav-group">
          <div class="nav-group-title">账号</div>
          <div class="nav-item">个人信息</div>
        </div>
        <div class="nav-group">
          <div class="nav-group-title">系统</div>
          <div class="nav-item">数据库增强</div>
          <div class="nav-item">定时任务</div>
          <div class="nav-item">API 开发接口</div>
          <div class="nav-item">关于</div>
        </div>
        <div class="side-foot"><span class="avatar">D</span><div><b>管理员</b><br /><span>demo</span></div></div>
      </aside>`;

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font); background: var(--desktop); color: var(--text); -webkit-font-smoothing: antialiased; display: grid; place-items: center; min-height: 100vh; transition: background .25s ease, color .25s ease; }
  .window { width: 960px; height: 720px; background: var(--main); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 24px 80px rgba(0,0,0,.45); border: 1px solid var(--border); transition: background .25s ease, border-color .25s ease, box-shadow .25s ease; }
  .titlebar { height: 42px; flex: none; background: var(--titlebar); border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 14px; gap: 10px; -webkit-user-select: none; user-select: none; transition: background .25s ease, border-color .25s ease; }
  .traffic { display: flex; gap: 8px; }
  .traffic i { width: 12px; height: 12px; border-radius: 50%; display: block; }
  .traffic i:nth-child(1) { background: #ff5f57; } .traffic i:nth-child(2) { background: #febc2e; } .traffic i:nth-child(3) { background: #28c840; }
  .tb-title { font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-left: 8px; }
  .tb-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .theme-toggle { height: 24px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--main); color: var(--text-2); font-size: 10.5px; font-weight: 600; cursor: pointer; transition: color .2s, border-color .2s; }
  .theme-toggle:hover { color: var(--text); border-color: var(--accent); }
  .save-pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; background: var(--accent-soft); color: var(--green); font-size: 10.5px; font-weight: 600; }
  .ver { font-size: 10.5px; color: var(--text-3); }
  .body { flex: 1; display: flex; min-height: 0; }
  .sidebar { width: 184px; flex: none; background: var(--sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 10px 8px; transition: background .25s ease, border-color .25s ease; }
  .side-logo { display: flex; align-items: center; gap: 7px; padding: 4px 8px 10px; }
  .side-logo .mark { width: 22px; height: 22px; border-radius: 6px; background: var(--accent-soft); border: 1px solid var(--border); display: grid; place-items: center; color: var(--accent); font-weight: 800; font-size: 11px; transition: background .25s, border-color .25s; }
  .side-logo b { font-size: 13px; font-weight: 600; }
  .search-btn { display: flex; align-items: center; gap: 7px; width: 100%; height: 32px; padding: 0 9px; border-radius: 7px; background: var(--main); border: 1px solid var(--border); color: var(--text-3); font-size: 12px; cursor: pointer; transition: background .2s, border-color .2s; }
  .search-btn:hover { color: var(--text-2); }
  .search-btn svg { width: 13px; height: 13px; }
  .nav-group { margin-top: 12px; }
  .nav-group-title { padding: 0 8px 4px; font-size: 10px; font-weight: 700; color: var(--text-3); letter-spacing: .06em; }
  .nav-item { display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 8px; border-radius: 6px; color: var(--text-2); font-size: 12px; cursor: pointer; transition: background .2s, color .2s; }
  .nav-item:hover { background: var(--sidebar-hover); color: var(--text); }
  .nav-item.active { background: var(--sidebar-hover); color: var(--text); font-weight: 600; }
  .nav-item .badge { margin-left: auto; font-size: 9px; color: var(--green); background: var(--accent-soft); border-radius: 3px; padding: 0 5px; }
  .side-foot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-top: 1px solid var(--border); }
  .avatar { width: 24px; height: 24px; border-radius: 50%; background: var(--accent); display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff; }
  .side-foot b { font-size: 11.5px; font-weight: 600; }
  .side-foot span { font-size: 9.5px; color: var(--text-3); }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .content { flex: 1; overflow-y: auto; padding: 16px 22px 24px; }
  .group { margin-bottom: 20px; }
  .group-title { font-size: 11px; font-weight: 700; color: var(--text-3); padding: 0 2px 7px; letter-spacing: .04em; }
  .rows { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--rows); transition: background .25s ease, border-color .25s ease; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--row-h); padding: 7px 14px; transition: background .2s; }
  .row + .row { border-top: 1px solid var(--border); }
  .row:hover { background: var(--row-hover); }
  .row-label b { display: block; font-size: 12.5px; font-weight: 600; }
  .row-label span { font-size: 10.5px; color: var(--text-3); }
  .ctrl { display: flex; align-items: center; gap: 8px; }
  .input { height: 30px; width: 220px; background: var(--input); border: 1px solid var(--border); border-radius: 7px; padding: 0 10px; font-size: 12px; color: var(--text); outline: none; text-align: right; transition: background .25s ease, border-color .25s ease, color .25s ease; }
  .input:focus { border-color: var(--accent); }
  .pills { display: flex; gap: 5px; }
  .pill { height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--main); font-size: 11.5px; color: var(--text-2); cursor: pointer; transition: background .2s, border-color .2s, color .2s; }
  .pill.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg, #fff); font-weight: 600; }
  .switch { width: 34px; height: 20px; border-radius: 999px; background: var(--switch-off); position: relative; cursor: pointer; flex: none; transition: background .25s; }
  .switch.on { background: var(--accent); }
  .switch::after { content: ""; position: absolute; top: 2.5px; left: 2.5px; width: 15px; height: 15px; border-radius: 50%; background: #fff; transition: .18s; }
  .switch.on::after { left: 16.5px; }
  .btn { height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--border); background: var(--main); font-size: 11.5px; font-weight: 600; color: var(--text-2); cursor: pointer; transition: color .2s, border-color .2s, background .2s; }
  .btn:hover { color: var(--text); border-color: var(--accent); }
  .status { font-size: 11px; color: var(--green); display: inline-flex; align-items: center; gap: 5px; }
  .status .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }
  .font-preview { font-size: 24px; font-weight: 800; letter-spacing: 2px; }
  .hint { font-size: 10.5px; color: var(--text-3); }
  .statusbar { height: 26px; flex: none; background: var(--titlebar); border-top: 1px solid var(--border); display: flex; align-items: center; padding: 0 14px; font-size: 10.5px; color: var(--text-3); gap: 16px; transition: background .25s ease, border-color .25s ease; }
  .statusbar .ok { color: var(--green); }
  .statusbar .right { margin-left: auto; }
`;

const THEMES = [
  {
    file: "settings-blue.html",
    title: "设置 · 清新蓝（长桥向）",
    light: `
    :root {
      --desktop: #eef3f9; --titlebar: #ffffff; --sidebar: #f7fafd;
      --sidebar-hover: #e9f1fb; --main: #ffffff; --row-hover: #f4f8fd;
      --border: #e2eaf3; --rows: #ffffff; --input: #fbfdff;
      --text: #16233a; --text-2: #5b6b82; --text-3: #93a3b8;
      --accent: #2f8cf0; --accent-soft: rgba(47,140,240,.1); --accent-fg: #fff;
      --green: #16a085; --switch-off: #d7e0ea; --row-h: 42px;
      --font: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    }
    .window { box-shadow: 0 20px 60px rgba(28,64,112,.12); }
    .nav-item.active { background: var(--accent-soft); color: var(--accent); }
    .mark { background: linear-gradient(135deg,#5aa9ff,#2f8cf0); border: 0; color: #fff; }`,
    dark: `
    body.dark {
      --desktop: #0d1724; --titlebar: #111c2b; --sidebar: #111c2b;
      --sidebar-hover: #1a2a3f; --main: #0f1a28; --row-hover: #16253a;
      --border: #1f2f45; --rows: transparent; --input: #16233a;
      --text: #e7eef7; --text-2: #a5b9cf; --text-3: #5f7690;
      --accent: #4da3ff; --accent-soft: rgba(77,163,255,.14); --accent-fg: #fff;
      --green: #2fc496; --switch-off: #24364e; --row-h: 42px;
    }
    body.dark .nav-item.active { color: #7db8ff; }
    body.dark .mark { background: linear-gradient(135deg,#6ab4ff,#3d8ef5); }`
  },
  {
    file: "settings-redblack.html",
    title: "设置 · 红黑经典（雪球向）",
    light: `
    :root {
      --desktop: #ececec; --titlebar: #1a1a1a; --sidebar: #161616;
      --sidebar-hover: #262626; --main: #f7f7f7; --row-hover: #ffffff;
      --border: #e0e0e0; --rows: #ffffff; --input: #ffffff;
      --text: #1a1a1a; --text-2: #555; --text-3: #999;
      --accent: #e64545; --accent-soft: rgba(230,69,69,.1); --accent-fg: #fff;
      --green: #1f9d63; --switch-off: #d5d5d5; --row-h: 42px;
      --font: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    }
    .titlebar, .sidebar { color: #d8d8d8; }
    .nav-item { color: #a8a8a8; }
    .nav-item.active, .nav-item:hover { color: #fff; background: #2a2a2a; }
    .nav-group-title { color: #777; }
    .side-foot b { color: #fff; }
    .tb-title { color: #bbb; }
    .mark { background: var(--accent); border: 0; color: #fff; }`,
    dark: `
    body.dark {
      --desktop: #101010; --titlebar: #161616; --sidebar: #161616;
      --sidebar-hover: #232323; --main: #121212; --row-hover: #191919;
      --border: #2a2a2a; --rows: transparent; --input: #1a1a1a;
      --text: #e8e8e8; --text-2: #a8a8a8; --text-3: #6a6a6a;
      --accent: #ff5b5b; --accent-soft: rgba(255,91,91,.13); --accent-fg: #fff;
      --green: #2fae77; --switch-off: #333; --row-h: 42px;
    }
    body.dark .nav-item.active, body.dark .nav-item:hover { color: #fff; background: #2a2a2a; }
    body.dark .mark { background: #ff5b5b; }`
  },
  {
    file: "settings-v17.html",
    title: "设置 · V17 石墨黑金",
    light: `
    :root {
      --desktop: #efece4; --titlebar: #f8f6f0; --sidebar: #f3f0e8;
      --sidebar-hover: #e9e4d8; --main: #fbfaf6; --row-hover: #f5f2ea;
      --border: #e3ddcd; --rows: #fffdf8; --input: #fffdf8;
      --text: #2b2820; --text-2: #6f695b; --text-3: #a39c8b;
      --accent: #b08d3f; --accent-soft: rgba(176,141,63,.12); --accent-fg: #fff;
      --green: #7f9d6a; --switch-off: #ddd6c4; --row-h: 44px;
      --font: -apple-system, BlinkMacSystemFont, "PingFang SC", serif;
    }
    .tb-title, .side-logo b, .nav-item.active, .font-preview { font-family: Georgia, "Iowan Old Style", serif; }
    .mark { background: linear-gradient(135deg,#d8bc7e,#a9853f); border: 0; color: #141414; }
    .nav-item.active { color: #8f6f2e; }
    .switch.on { background: linear-gradient(90deg,#c9a45c,#a9853f); }`,
    dark: `
    body.dark {
      --desktop: #0b0b0e; --titlebar: #141417; --sidebar: #141417;
      --sidebar-hover: #202024; --main: #101013; --row-hover: #17171b;
      --border: #26262c; --rows: transparent; --input: #17171b;
      --text: #ece7da; --text-2: #a8a294; --text-3: #6f6a5e;
      --accent: #c9a45c; --accent-soft: rgba(201,164,92,.12); --accent-fg: #141414;
      --green: #8fbf8f; --switch-off: #2b2b31; --row-h: 44px;
    }
    body.dark .tb-title, body.dark .side-logo b, body.dark .nav-item.active { font-family: Georgia, "Iowan Old Style", serif; }
    body.dark .nav-item.active { color: #d4b46a; }
    body.dark .mark { background: linear-gradient(135deg,#e2c98c,#a9853f); color: #141414; }`
  },
  {
    file: "settings-v18.html",
    title: "设置 · V18 磨砂玻璃",
    light: `
    body { background: linear-gradient(135deg,#dbe7ff 0%,#f3e3ff 45%,#d8f5ef 100%); }
    body::before { content:""; position: fixed; inset: 0; background: radial-gradient(600px 300px at 15% 20%, rgba(255,255,255,.65), transparent 60%), radial-gradient(500px 320px at 85% 75%, rgba(255,255,255,.55), transparent 60%); pointer-events: none; }
    :root {
      --desktop: transparent; --titlebar: rgba(255,255,255,.62); --sidebar: rgba(255,255,255,.5);
      --sidebar-hover: rgba(255,255,255,.7); --main: rgba(255,255,255,.45); --row-hover: rgba(255,255,255,.62);
      --border: rgba(255,255,255,.75); --rows: rgba(255,255,255,.28); --input: rgba(255,255,255,.75);
      --text: #27324a; --text-2: #5f6c85; --text-3: #97a4ba;
      --accent: #7c6cf0; --accent-soft: rgba(124,108,240,.14); --accent-fg: #fff;
      --green: #2fb98b; --switch-off: rgba(255,255,255,.55); --row-h: 42px;
      --font: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    }
    .window, .titlebar, .sidebar, .rows, .input, .pill, .btn, .theme-toggle { backdrop-filter: blur(18px) saturate(1.4); -webkit-backdrop-filter: blur(18px) saturate(1.4); }
    .window { box-shadow: 0 24px 70px rgba(60,70,120,.2); }
    .mark { background: linear-gradient(135deg,#a78bfa,#7c6cf0); border: 0; color: #fff; }
    .pill.active { background: linear-gradient(135deg,#a78bfa,#7c6cf0); border-color: transparent; color: #fff; }`,
    dark: `
    body.dark { background: linear-gradient(135deg,#10101c 0%,#1b1226 45%,#0d181a 100%); }
    body.dark::before { background: radial-gradient(600px 300px at 15% 20%, rgba(255,255,255,.08), transparent 60%), radial-gradient(500px 320px at 85% 75%, rgba(255,255,255,.06), transparent 60%); }
    body.dark {
      --titlebar: rgba(24,24,34,.6); --sidebar: rgba(24,24,34,.55);
      --sidebar-hover: rgba(255,255,255,.08); --main: rgba(24,24,34,.42); --row-hover: rgba(255,255,255,.07);
      --border: rgba(255,255,255,.14); --rows: rgba(255,255,255,.04); --input: rgba(255,255,255,.09);
      --text: #eceaf5; --text-2: #aaa9c2; --text-3: #77758f;
      --accent: #a78bfa; --accent-soft: rgba(167,139,250,.16); --accent-fg: #fff;
      --green: #45d6aa; --switch-off: rgba(255,255,255,.18); --row-h: 42px;
    }
    body.dark .window { box-shadow: 0 24px 70px rgba(0,0,0,.55); }
    body.dark .pill.active { background: linear-gradient(135deg,#b49dff,#8f7bf5); }`
  },
  {
    file: "settings-tradingview.html",
    title: "设置 · TradingView 风",
    light: `
    :root {
      --desktop: #f7f8fa; --titlebar: #ffffff; --sidebar: #f7f8fa;
      --sidebar-hover: #eef0f3; --main: #ffffff; --row-hover: #f7f8fa;
      --border: #e6e9ef; --rows: #ffffff; --input: #ffffff;
      --text: #131722; --text-2: #4f5966; --text-3: #9aa3b5;
      --accent: #2962ff; --accent-soft: rgba(41,98,255,.1); --accent-fg: #fff;
      --green: #089981; --switch-off: #d8dce3; --row-h: 38px;
      --font: -apple-system, "Trebuchet MS", "PingFang SC", sans-serif;
    }
    .row { min-height: 38px; padding: 5px 14px; }
    .nav-item.active { color: var(--accent); background: var(--accent-soft); }
    .mark { background: var(--accent); border: 0; color: #fff; }
    .badge { background: rgba(8,153,129,.12); }`,
    dark: `
    body.dark {
      --desktop: #131722; --titlebar: #1e222d; --sidebar: #1e222d;
      --sidebar-hover: #2a2e39; --main: #131722; --row-hover: #1e222d;
      --border: #2a2e39; --rows: transparent; --input: #1e222d;
      --text: #d1d4dc; --text-2: #9598a1; --text-3: #787b86;
      --accent: #2962ff; --accent-soft: rgba(41,98,255,.14); --accent-fg: #fff;
      --green: #089981; --switch-off: #2a2e39; --row-h: 38px;
    }
    body.dark .row { min-height: 38px; padding: 5px 14px; }
    body.dark .nav-item.active { color: #7ea0ff; }`
  },
  {
    file: "settings-v2ex.html",
    title: "设置 · V2EX 风",
    light: `
    :root {
      --desktop: #e2e2e2; --titlebar: #f5f5f5; --sidebar: #f5f5f5;
      --sidebar-hover: #e9e9e9; --main: #ffffff; --row-hover: #fbfbfb;
      --border: #e0e0e0; --rows: #ffffff; --input: #fbfbfb;
      --text: #555; --text-2: #778087; --text-3: #999;
      --accent: #428bca; --accent-soft: rgba(66,139,202,.1); --accent-fg: #fff;
      --green: #6aa84f; --switch-off: #d7d7d7; --row-h: 40px;
      --font: -apple-system, "Helvetica Neue", "PingFang SC", sans-serif;
    }
    .tb-title { color: #555; }
    .nav-item.active { color: #428bca; background: transparent; }
    .nav-item:hover { color: #333; background: #ececec; }
    .mark { background: #778087; border: 0; color: #fff; border-radius: 4px; }
    .search-btn { background: #fbfbfb; }`,
    dark: `
    body.dark {
      --desktop: #1a1a1a; --titlebar: #202020; --sidebar: #202020;
      --sidebar-hover: #2b2b2b; --main: #1c1c1c; --row-hover: #222;
      --border: #333; --rows: transparent; --input: #242424;
      --text: #ccc; --text-2: #999; --text-3: #777;
      --accent: #4f9bd6; --accent-soft: rgba(79,155,214,.13); --accent-fg: #fff;
      --green: #7db95e; --switch-off: #3a3a3a; --row-h: 40px;
    }
    body.dark .tb-title { color: #ccc; }
    body.dark .nav-item.active { color: #6fb0e0; }
    body.dark .nav-item:hover { color: #ddd; background: #2b2b2b; }
    body.dark .search-btn { background: #242424; }`
  },
  {
    file: "settings-okx.html",
    title: "设置 · 欧易 OKX 风",
    light: `
    :root {
      --desktop: #f5f7fa; --titlebar: #ffffff; --sidebar: #eef2f7;
      --sidebar-hover: #e2e9f1; --main: #ffffff; --row-hover: #f4f8fc;
      --border: #e3e8ef; --rows: #ffffff; --input: #fbfdff;
      --text: #1b2129; --text-2: #5f6b7a; --text-3: #98a2b0;
      --accent: #00a8ff; --accent-soft: rgba(0,168,255,.1); --accent-fg: #fff;
      --green: #00c988; --switch-off: #d8e0e8; --row-h: 42px;
      --font: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    }
    .nav-item.active { color: #008fd9; background: rgba(0,168,255,.08); }
    .mark { background: linear-gradient(135deg,#00c2ff,#0055ff); border: 0; color: #fff; }
    .pill.active { background: linear-gradient(135deg,#00c2ff,#0055ff); border-color: transparent; color: #fff; }
    .badge { background: rgba(0,201,136,.12); }`,
    dark: `
    body.dark {
      --desktop: #0b0e11; --titlebar: #161a20; --sidebar: #161a20;
      --sidebar-hover: #22272f; --main: #0b0e11; --row-hover: #161a20;
      --border: #262c36; --rows: transparent; --input: #161a20;
      --text: #eaecef; --text-2: #8d97a5; --text-3: #5f6b7a;
      --accent: #00b7ff; --accent-soft: rgba(0,183,255,.12); --accent-fg: #fff;
      --green: #00c988; --switch-off: #2b333d; --row-h: 42px;
    }
    body.dark .nav-item.active { color: #fff; background: linear-gradient(90deg, rgba(0,183,255,.22), rgba(0,183,255,.05)); }
    body.dark .mark { background: linear-gradient(135deg,#00c2ff,#0055ff); }`
  },
  {
    file: "settings-binance.html",
    title: "设置 · 币安风",
    light: `
    :root {
      --desktop: #f7f7f7; --titlebar: #ffffff; --sidebar: #fafafa;
      --sidebar-hover: #f0f0f0; --main: #ffffff; --row-hover: #fafafa;
      --border: #e6e6e6; --rows: #ffffff; --input: #ffffff;
      --text: #1e2329; --text-2: #707a8a; --text-3: #a3aab4;
      --accent: #f0b90b; --accent-soft: rgba(240,185,11,.12); --accent-fg: #141414;
      --green: #0ecb81; --switch-off: #dcdcdc; --row-h: 42px;
      --font: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    }
    .nav-item.active { color: #d6a400; background: rgba(240,185,11,.08); }
    .mark { background: linear-gradient(135deg,#fcd535,#f0b90b); border: 0; color: #141414; }
    .pill.active { background: #fcd535; border-color: #fcd535; color: #141414; }
    .switch.on { background: #f0b90b; }
    .badge { background: rgba(240,185,11,.14); }`,
    dark: `
    body.dark {
      --desktop: #0b0e11; --titlebar: #181a20; --sidebar: #181a20;
      --sidebar-hover: #20242c; --main: #0b0e11; --row-hover: #181a20;
      --border: #2b3139; --rows: transparent; --input: #181a20;
      --text: #eaecef; --text-2: #9aa0a8; --text-3: #5e6673;
      --accent: #f0b90b; --accent-soft: rgba(240,185,11,.12); --accent-fg: #141414;
      --green: #0ecb81; --switch-off: #2e333c; --row-h: 42px;
    }
    body.dark .nav-item.active { color: #f0b90b; }
    body.dark .mark { background: linear-gradient(135deg,#fcd535,#f0b90b); }`
  },
  {
    file: "settings-apple.html",
    title: "设置 · Apple 液态玻璃（Liquid Glass）",
    light: `
    body { background: linear-gradient(135deg,#8ec5fc 0%,#e0c3fc 45%,#f9a8d4 100%); }
    body::before { content:""; position: fixed; inset: 0; background: radial-gradient(700px 360px at 18% 18%, rgba(255,255,255,.55), transparent 60%), radial-gradient(620px 400px at 82% 72%, rgba(255,255,255,.4), transparent 60%); pointer-events: none; }
    :root {
      --desktop: transparent; --titlebar: rgba(255,255,255,.55); --sidebar: rgba(255,255,255,.42);
      --sidebar-hover: rgba(255,255,255,.65); --main: rgba(255,255,255,.38); --row-hover: rgba(255,255,255,.55);
      --border: rgba(255,255,255,.7); --rows: rgba(255,255,255,.26); --input: rgba(255,255,255,.62);
      --text: #1c1c1e; --text-2: #5f5f66; --text-3: #9b9ba1;
      --accent: #0a84ff; --accent-soft: rgba(10,132,255,.14); --accent-fg: #fff;
      --green: #34c759; --switch-off: rgba(255,255,255,.55); --row-h: 42px;
      --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
    }
    .window { position: relative; box-shadow: 0 30px 90px rgba(60,80,140,.28), inset 0 0 0 .5px rgba(255,255,255,.45); }
    .window::before { content:""; position: absolute; left: 10%; right: 10%; top: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,.95), transparent); }
    .window, .titlebar, .sidebar, .rows, .input, .pill, .btn, .theme-toggle, .mark { backdrop-filter: blur(24px) saturate(1.8); -webkit-backdrop-filter: blur(24px) saturate(1.8); }
    .mark { background: linear-gradient(135deg, rgba(255,255,255,.8), rgba(255,255,255,.35)); border: 1px solid rgba(255,255,255,.8); color: #0a84ff; }
    .pill.active { background: rgba(10,132,255,.9); border-color: rgba(255,255,255,.6); color: #fff; }
    .switch.on { background: #34c759; }
    .search-btn { background: rgba(255,255,255,.5); }`,
    dark: `
    body.dark { background: linear-gradient(135deg,#101c3a 0%,#2a1650 48%,#451b3a 100%); }
    body.dark::before { background: radial-gradient(700px 360px at 18% 18%, rgba(255,255,255,.12), transparent 60%), radial-gradient(620px 400px at 82% 72%, rgba(255,255,255,.1), transparent 60%); }
    body.dark {
      --titlebar: rgba(28,28,34,.62); --sidebar: rgba(28,28,34,.5);
      --sidebar-hover: rgba(255,255,255,.09); --main: rgba(28,28,34,.4); --row-hover: rgba(255,255,255,.07);
      --border: rgba(255,255,255,.18); --rows: rgba(255,255,255,.05); --input: rgba(255,255,255,.1);
      --text: #f2f2f7; --text-2: #b0b0b8; --text-3: #77777f;
      --accent: #0a84ff; --accent-soft: rgba(10,132,255,.2); --accent-fg: #fff;
      --green: #30d158; --switch-off: rgba(255,255,255,.2); --row-h: 42px;
    }
    body.dark .window { box-shadow: 0 30px 90px rgba(0,0,0,.6), inset 0 0 0 .5px rgba(255,255,255,.12); }
    body.dark .window::before { background: linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent); }
    body.dark .mark { background: linear-gradient(135deg, rgba(255,255,255,.22), rgba(255,255,255,.08)); color: #6db4ff; }
    body.dark .switch.on { background: #30d158; }
    body.dark .pill.active { background: rgba(10,132,255,.85); }`
  }
];

for (const t of THEMES) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t.title}</title>
<style>
${t.light}
${t.dark}
${BASE_CSS}
</style>
</head>
<body>
<div class="window">
  <div class="titlebar">
    <div class="traffic"><i></i><i></i><i></i></div>
    <span class="tb-title">Fire 设置</span>
    <div class="tb-right">
      <button class="theme-toggle" id="tt" onclick="document.body.classList.toggle('dark');document.getElementById('tt').textContent=document.body.classList.contains('dark')?'浅色':'深色'">深色</button>
      <span class="save-pill">✓ 已保存</span><span class="ver">v0.1.14</span>
    </div>
  </div>
  <div class="body">
${SIDEBAR}
    <div class="main">
      <div class="content">
${CONTENT}
      </div>
      <div class="statusbar">
        <span class="ok">● 富途 OpenD 已连接</span>
        <span>行情源：富途 · 备用腾讯 + Yahoo</span>
        <span class="right">修改自动保存</span>
      </div>
    </div>
  </div>
</div>
</body>
</html>
`;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, t.file), html);
  console.log("generated", t.file);
}
