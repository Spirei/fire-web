/**
 * Fire · 版本记录（单一数据源）
 *
 * 结构：本文件保存 类型 + 当前版本条目（CURRENT_VERSION_ENTRY）+ CURRENT_VERSION；
 * 历史版本数组 VERSIONS 已拆分到 lib/versions-history.ts（仅供版本弹窗懒加载，避免约
 * 200KB 历史文案进入首屏包）。需要完整历史时 import { VERSIONS } from "./versions-history"。
 *
 * 维护约定（每次更新都写进这里，然后同步一份到仓库根目录 VERSIONS.md）：
 * 1. 版本以「日」为判断标准：同一天内的多次更新合并进当天版本号，不单独递增；
 *    跨过凌晨（新的一天）后的首次更新才开启新的版本号（v0.1.0 → v0.1.1 → v0.1.2 ...）。
 * 2. 每个 VersionEntry 对应一个日期（date 字段），同一天的改动追加到该条目的 changes 里。
 * 3. 变更按类型标记：feature（新功能）/ fix（修复）/ security（安全），UI 会带标签区分。
 * 4. 修改技术栈（新框架 / 新库 / 新数据源）后，同步更新 frontend 或 techStack。
 * 5. 跨天新版本：把旧 CURRENT_VERSION_ENTRY 移入 versions-history.ts 的 VERSIONS 数组
 *    头部（替换其中的 CURRENT_VERSION_ENTRY 占位引用），再在本文件写入新条目。
 * 6. 运行 / 启动基础设施（fire-Start.up 启动脚本、进程守护、部署方式等脱离 Web / iOS 产品代码的部分）
 *    不写入版本记录；只有 Web / iOS 自身的功能、修复、安全与技术栈变化才记录。
 */

export interface VersionStackItem {
  name: string;
  version: string;
  desc: string;
}

export type ChangeKind = "feature" | "fix" | "security";

export interface VersionChange {
  title: string;
  desc: string;
  kind: ChangeKind;
}

export interface VersionEntry {
  /** 版本号，如 v0.1.0 */
  version: string;
  /** 发布日期 YYYY-MM-DD */
  date: string;
  /** 一句话版本摘要 */
  summary: string;
  /** 前端 / 运行栈版本明细 */
  frontend: VersionStackItem[];
  /** 软件本体版本 */
  software: VersionStackItem[];
  /** 新功能 / 修复 / 安全（按序号展示） */
  changes: VersionChange[];
}

export const V0_1_9_ENTRY: VersionEntry = {
  version: "v0.1.9",
  date: "2026-08-15",
  summary: "我的持仓-持仓盈利桑基图优化：正股显示名称、2倍ETF显示代码、块上显示盈亏金额，并支持一键导出 / 复制分享图片。",
    frontend: [
      { name: "Next.js", version: "15.5.22", desc: "App Router · 服务端 / 客户端组件" },
      { name: "React", version: "19.0.0", desc: "Hooks · 组件化开发" },
      { name: "TypeScript", version: "5.7.3", desc: "全链路类型安全" },
      { name: "Tailwind CSS", version: "3.4.17", desc: "原子化样式 · 深浅色主题" },
      { name: "GSAP", version: "3.15.0", desc: "动画引擎 · 磁吸 / 波纹 / 弹窗动效" },
      { name: "ECharts", version: "6.1.0", desc: "K 线图 / 桑基图（candlestick · sankey · dataZoom）" },
      { name: "Apple Vision", version: "macOS 13+", desc: "VNRecognizeTextRequest · 截图本地识别（不上云）" },
      { name: "better-sqlite3", version: "13.0.2", desc: "SQLite 本地存储（默认）" },
      { name: "pg", version: "8.22.0", desc: "PostgreSQL 可选数据库" },
      { name: "Node.js", version: "22.23.2", desc: "服务端运行时" },
      { name: "SwiftUI", version: "iOS 16+", desc: "iOS App（Swift 5.9 · Async/Await · URLSession）对接 /api/v1" }
    ],
    software: [
      { name: "Fire", version: "v0.1.9", desc: "账户资产 · 自选股 · 全球预览 · 财报日历 · 素材库 · 日志 · 用户管理 · 设置" }
    ],
    changes: [
      { title: "持仓盈利桑基图优化（名称/代码规则 + 金额 + 分享图片）", desc: "按参考图优化我的持仓-持仓盈利图（桑基图）：1) 节点标签规则——正股只显示股票名称、2倍杠杆 ETF（名称含 2倍/2x 且带 ETF/做多/做空）只显示代码，不再「代码+名称」连排；2) 每个块下方显示盈亏金额（跟随当前选择货币换算，盈利红色 + / 亏损绿色 −，中心「持仓盈亏」块显示净盈亏）；3) 新增「分享」按钮：ECharts 2 倍像素导出 PNG，支持复制到剪贴板直接粘贴分享（非安全上下文自动回退下载文件），深浅色背景随主题。tsc 无错误、npm run build 通过。", kind: "feature" },
      { title: "持仓盈利桑基图美化（拥挤优化）", desc: "按反馈优化桑基图拥挤问题：1) 块上金额缩写——≥1 亿显示亿、≥1 万显示万（如 +$1.23万），不再挤长串数字；2) 名称与金额两行用 rich 分层样式（名称 11px 主色、金额 10px 辅助色），盈利红 / 亏损绿 / 中心紫；3) 画布高度 285→380px、节点加宽 14、间距 18、左右留白 170、连线透明度 0.7→0.55，整体更透气；4) 中心「持仓盈亏」块同步显示净盈亏缩写。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "桑基图分享改为先预览再保存（不直接下载）", desc: "按用户要求：点击「分享」先生成 2 倍像素 PNG 并在弹窗内预览，弹窗提供「复制图片」（写入剪贴板，非安全上下文自动回退保存）与「保存图片」（下载 PNG）两个确认操作，分享前可检查内容，不再点击即下载。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "桑基图分享卡片重设计（LOGO + 标题 + 汇总 + html2canvas 导出）", desc: "按参考图重做分享图：点击「分享」生成白底分享卡片——左上角站点 LOGO + 站点名（读 /api/settings/public，缺失用默认趋势图标），右上角「持仓盈利图」标题 + 日期；中间为桑基图（分享时临时切浅色渲染保证白底观感，截取后恢复原主题）；下方带 总盈利 = 盈利总额 − 亏损总额 汇总块与页脚水印；引入 html2canvas（2 倍像素）把整张卡片渲染成 PNG 后进入预览弹窗，再复制/保存。tsc 无错误、npm run build 通过。", kind: "feature" },
      { title: "分享预览按钮逻辑修正（复制不下载）", desc: "按用户要求修正逻辑：预览弹窗里「复制图片」失败时只提示「复制失败，请使用保存图片」，不再回退触发下载；下载只发生在点击「保存图片」。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "分享卡片精简 + 跟随深浅色主题（浅色白底 / 深色黑底）", desc: "按用户要求：1) 删除分享卡片底部水印文字「Fire · 持仓盈亏分布 · 数据仅供参考」；2) 把「总盈利 = 盈利总额 − 亏损总额」汇总块从图表下方移到图表上方；3) 分享图跟随当前主题——浅色模式白底深字、深色模式 #16181d 黑底浅字（标题/日期/汇总块边框与背景同步切换），图表截图与 html2canvas 导出背景随主题一致。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "分享图复制兼容局域网 http（服务端写入 Mac 剪贴板）", desc: "修复局域网 http（非安全上下文）下「复制图片」失败的问题：浏览器 navigator.clipboard 在非安全上下文不可用，新增 POST /api/clipboard——前端复制失败时把 PNG 交给服务端，用 osascript 写入 Mac 系统剪贴板（登录 + 限流 + PNG 魔数校验 + ≤8MB + 服务端生成临时文件名，无注入面），聊天窗口（微信等）可直接粘贴；安全上下文仍走浏览器剪贴板 API。实测接口 200、剪贴板内容正确（测试后已恢复原剪贴板）。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "修复复制图片兜底不生效（浏览器 API 抛错被外层 catch 吞掉）", desc: "修复「复制图片」仍失败且剪贴板图片异常的问题：原逻辑把浏览器剪贴板 API 与服务端兜底放在同一个 try 里，当 navigator.clipboard.write 抛错（如 NotAllowedError：文档未聚焦/权限被拒）时会直接跳到外层 catch 显示失败，服务端 osascript 兜底根本没执行（服务日志也证实没有来自浏览器的 /api/clipboard 请求）。修复：浏览器 API 单独 try/catch，失败后继续走服务端写入 Mac 剪贴板；复制失败时 toast 显示具体错误信息便于后续排查。服务端路径已用 4.5MB 大图实测逐像素一致。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "分享预览弹窗按钮字体色统一", desc: "按用户反馈：预览弹窗「保存图片」按钮文字原为 ink-2 灰色，与「关闭」「复制图片」的 ink 深色不一致，补 text-ink 对齐三个按钮文字颜色。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "复制图片改用 atob 转 Blob（不依赖 fetch(data:)，兼容 Safari）", desc: "排查「复制图片仍失败」：服务日志证实浏览器请求从未到达 /api/clipboard，怀疑 `fetch(data:image/png;base64,...).blob()` 在部分浏览器（如 Safari 对 data URL fetch 支持不完整）抛错，直接走到「图片数据生成失败」。修复：不再用 fetch 转 Blob，改为 atob 解码 data URL 直接构造 Blob（所有浏览器通用），浏览器 API 与服务端兜底两条路径均重新实测通过（服务端路径触发时 /api/clipboard 有请求、系统剪贴板拿到图片）；复制失败时 toast 显示具体错误并 console.error 便于排查。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "复制图片后保留分享预览弹窗", desc: "按用户要求：点「复制图片」成功后不再自动关闭预览弹窗，可继续查看或再次操作；关闭仍由「关闭」按钮完成。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "分享卡片改为薰衣草紫相框式布局（外层包裹白/深色内容）", desc: "按参考图重设计分享卡片：外层整体使用参考图背景色 #A5A5BF（淡薰衣草紫，从参考图取色 165,165,191）作为相框，把内层白/深色内容块包裹起来；内层包含品牌栏（LOGO+站点名 / 持仓盈利图+日期）、汇总块与桑基图，浅色模式白底深字、深色模式 #16181d 黑底浅字。tsc 无错误、npm run build 通过，导出图已实测外层 165,165,191、内层白底。", kind: "fix" },
      { title: "分享卡片按左图重构：紫底 + 头部浮层 + 独立圆角内容卡", desc: "仔细对比左右参考图后重构分享卡：1) 淡薰衣草紫 #A5A5BF 铺满整张卡片背景；2) LOGO（白底圆角占位/站点 Logo）+ 站点名 与 「持仓盈利图」+ 日期 直接浮在紫底上（深色文字，不套内容块）；3) 桑基图+汇总做成独立圆角卡片（18px 圆角 + 柔和阴影），左右留白 24px、顶部紫底留白约 124px，浅色模式白卡深字、深色模式 #16181d 黑卡浅字。导出图实测：顶部紫底、内容卡左/右边距 24px、圆角内收正常。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "分享卡片压缩上下留白", desc: "按反馈：上下薰衣草紫留白太多显得卡片过宽。压缩外层边距（顶部 52→22px、底部 40→22px、左右 24→20px）、头部与内容卡间距 22→14px，内容卡内边距同步收紧。实测卡片高度 490→432px、顶部紫底 124→85px，整体更紧凑。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "分享预览弹窗去除提示文字 + 分享卡进一步压缩", desc: "1) 按用户要求删除预览弹窗副标题「确认内容后，可复制分享或保存图片」，后续不加多余文字；2) 继续压缩分享卡：外层紫底上下 22→14px、左右 20→16px，头部与内容卡间距 14→10px，LOGO 32→28px，内容卡内边距 16/22/18→12/16/14、圆角 18→14。实测卡片 720×410、顶部紫底 73px、左右留白 16px。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "分享图清晰度优化（3 倍导出 + 图表像素对齐 + 抗锯齿）", desc: "按反馈：分享图文字锐化/发虚。优化：1) html2canvas 导出倍率 2→3，输出分辨率提升 2.25 倍；2) ECharts 图表 pixelRatio 2→3，与捕获倍率对齐，避免图表被放大导致发虚；3) onclone + 内联样式设置 -webkit-font-smoothing: antialiased 与 text-rendering: geometricPrecision，文字边缘更干净。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "Swift OCR 模块缓存移出仓库 + Next 缓存阈值清理（瘦身约 1.2GB）", desc: "visionOcr.ts 编译模块缓存原放在 fire-web/.cache（实测 235MB），改为系统临时目录（系统管理、自动回收），仓库 .cache 仅保留 72KB 编译产物；新增 npm run clean:caches（scripts/clean-next-cache.mjs，阈值 200MB 自动清理 .next/.next-dev 缓存，--force 强制），fire.sh 启动前自动执行并新增 clean-cache 命令。本次清理：.next 782MB、.next-dev/cache 145MB、swift-module-cache 235MB、tsbuildinfo 与全部 .DS_Store，fire-web 由 1.0GB 降至 675MB。tsc 无错误、OCR 端到端验证 4 行正常。", kind: "fix" },
      { title: "资产分析跑赢数值移到向下箭头右侧", desc: "按参考图：基准条「跑赢 ● 基准名 ▾」的跑赢幅度（如 0.14%）从右对齐改为紧跟向下箭头右侧、与基准选择同组显示；隐藏态仍显示 ******，正负着色保留。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "每日盈亏分享图（纯白卡片：盈亏金额 / 持仓列表 / 持仓占比）", desc: "资产分析-账户资产卡新增分享按钮，生成每日盈亏分享图：1) 纯白卡片（不做紫底），头部 LOGO+站点名 / 每日盈亏+日期；2) 三个区块——盈亏金额（当日盈亏大数字 + 收益率，红涨绿跌）、持仓列表（按市值排序，2倍ETF显示代码、正股显示名称，最多 8 行 + 等 N 只）、持仓占比（ECharts 环形图 + 图例，前 8 只 + 其他）；3) 数据按展示货币换算，复用 html2canvas 3 倍导出与复制/保存/服务端剪贴板兜底，预览弹窗复制后保留、无多余文字；4) 数据链路已按持仓汇总当日盈亏与市值占比，为后续「盈亏日历图」预留。tsc 无错误、npm run build 通过、无头浏览器实测生成 1920×2133 白色卡片正常。", kind: "feature" },
      { title: "每日盈亏分享图重做（对齐参考图：色块金额 + 横向色条列表 + 大环形占比）", desc: "按反馈重做分享卡视觉效果：1) 盈亏金额改为浅红/浅绿渐变底的大数字色块（红涨绿跌，含今日收益率）；2) 持仓列表每行加横向色条（宽度按当日盈亏绝对值占比，红正绿负）；3) 持仓占比环形图加大（250×190）并加分隔线，图例不变；白色卡片、三区块顺序 盈亏金额 → 持仓列表 → 持仓占比 保持不变。tsc 无错误、npm run build 通过、实测卡片 1920×2265 色块/色条/环形齐全。", kind: "fix" },
      { title: "每日盈亏分享中心重做为长桥式卡片布局（接入第六版模板图）", desc: "按参考图（长桥分享卡）重做分享中心布局：1) 品牌栏（LOGO+站点名）+ 红色「转发」按钮；2) 当日持仓盈亏金额大数字 + 收益率（红涨绿跌）；3) 统计行 总资产 / 持仓市值 / 持仓总盈亏；4) 盈亏金额 / 持仓列表 / 持仓占比 三个可点击页签；5) 内容区展示对应模板图（第六版 盈利/亏损各 5 张，按当日盈亏正负自动切换目录、按页签/底部入口切换 1-5 号模板，不识别图中文字、原图直接使用）；6) 底部 5 入口（每日盈亏/持仓列表/持仓占比/盈亏日历/更多）可点击切换；7) 转发 = html2canvas 3 倍把整张卡片渲染成 PNG，预览后复制/保存。tsc 无错误、npm run build 通过、无头浏览器实测布局与切换、转发预览正常。", kind: "feature" },
      { title: "每日盈亏分享中心改为三块布局（顶部盈亏金额一排 / 左白色卡片 / 右分享缩略图）", desc: "按反馈重构整体布局为三块：1) 上方一整排盈亏金额——当日持仓盈亏金额 + 收益率 + 总资产 / 持仓市值 / 持仓总盈亏统计；2) 左侧白色卡片——品牌栏 + 当日盈亏金额 + 盈亏金额/持仓列表/持仓占比页签 + 模板图内容 + 底部 5 入口，可整体渲染成 PNG 分享；3) 右侧分享缩略图列——5 张模板缩略图，未选中置灰、选中才有颜色并高亮边框，点击切换左侧卡片；模板图仍按当日盈亏正负选盈利/亏损目录。tsc 无错误、npm run build 通过、无头浏览器实测三块布局、缩略图选中态与卡片联动正常。", kind: "feature" },
      { title: "删除每日盈亏分享功能", desc: "按用户要求整体删除每日盈亏分享：移除 DailyPnlShareModal 组件、资产分析页的分享按钮/相关数据计算与渲染，以及第六版模板图资源（盈利/亏损各 5 张，共 20MB，原图保留在用户桌面）；账户资产卡片恢复为仅刷新按钮。tsc 无错误、npm run build 通过、全仓库无残留引用。", kind: "fix" },
      { title: "前端包体积优化（视图按需加载 + ECharts 按需引入 + 版本历史懒加载 + 设置缓存）", desc: "针对后端应用首屏约 3.4MB JS 一次性下发做四项优化：1) 后端 11 个视图全部改为 next/dynamic 懒加载（仅下载当前激活页签代码，布局 chunk 813KB → 27KB）；2) ECharts 全量引入改为 echarts/core 按需注册（新增 lib/echarts.ts，只注册 candlestick/line/bar/sankey 与用到的组件 + Canvas 渲染器，图表 chunk 1104KB → 712KB 且仅含图表的页签才加载）；3) 版本历史约 200KB 文案拆分到 lib/versions-history.ts，版本弹窗懒加载（设置页 chunk 307KB → 101KB，历史只在点开弹窗时下载）；4) lib/settings.ts 的 getSiteSettings 加内存缓存（updateSiteSettings 写后失效），避免每个请求 / 每次行情批次全表 SELECT + JSON.parse。AGENTS.md 版本记录约定同步更新拆分后的维护方式。tsc 无错误、npm run build 通过。", kind: "fix" },
      { title: "分享当日盈亏卡片金额对齐修复（复制图片错位）", desc: "按反馈修复资产分析-账户资产-分享当日盈亏复制出的图片金额元素错位：1) 持仓市值右侧 USD 由 12px 小字改为与金额同字号（15px）并基线对齐；2) 当日持仓盈亏金额右侧 USD 由 flex 基线对齐改为行内基线布局（底部对齐、不再浮在数字上方），html2canvas 导出与页面渲染一致；3) 持仓市值前的 $ 圆形徽标重设计为单层居中（去掉嵌套 span 与 translate），消除复制图片中的上下错位。tsc 无错误、npm run build 通过。", kind: "fix" }
    ]
  };

export const V0_1_10_ENTRY: VersionEntry = {
  ...V0_1_9_ENTRY,
  version: "v0.1.10",
  date: "2026-08-16",
  summary: "资产分析持仓盈亏排行统一展示股票图标；修复当日盈亏分享图复制后圆角丢失、与预览不一致。",
  software: V0_1_9_ENTRY.software.map((item) =>
    item.name === "Fire" ? { ...item, version: "v0.1.10" } : item
  ),
  changes: [
    {
      title: "持仓盈亏排行改用股票图标",
      desc: "资产分析-持仓盈亏排行不再显示市场国旗，统一复用持仓表的股票图标解析与 ETF 正股图标映射；图标缺失时使用股票名称首字兜底。TypeScript 检查通过。",
      kind: "fix"
    },
    {
      title: "当日盈亏分享图复制后保留圆角透明背景",
      desc: "修复资产分析-账户资产-分享当日盈亏图复制出来与弹窗预览不一致：html2canvas 导出时不再强制填充白底，改为透明背景，让卡片自身的 48px 圆角与深浅色背景在复制出的 PNG 中保持一致，避免导出成白色矩形。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享弹窗预加载头像与模板图",
      desc: "修复点开每日盈亏分享弹窗时短暂显示默认头像/名称及右侧 5 张模板图空白：当前登录用户信息从外层 RecordsApp 一路传入分享弹窗，首帧即显示真实昵称与头像；同时新增模板图预加载（资产分析页挂载和点击分享时按盈亏方向预加载），避免打开后再请求图片造成闪空。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享弹窗内复制成功提示层级修复",
      desc: "修复每日盈亏分享弹窗内点「复制图片」后成功提示被弹窗遮挡的问题：全局 Toaster 层级由 z-[90] 提升到 z-[10001]，高于分享弹窗的 z-[10000]，复制成功/失败提示现在会显示在弹窗上方。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "复制图片反馈提速并统一提示文案",
      desc: "排查每日盈亏分享复制图片成功提示晚出约 1 秒的问题：html2canvas 改为弹窗挂载时即预加载，复制点击时先弹出「正在生成图片…」避免无反馈，完成后再提示「已复制图片」；避免首帧动态 import 和等待生成期间用户以为无响应。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "资产分析页签 URL 由 /assets 改为 /asset-analysis",
      desc: "资产分析从我的持仓剥离后一直沿用 /assets，与素材库 /api/assets 语义混淆；现将默认导航 URL 改为 /asset-analysis，并对已保存到 site_settings.tabs 的旧 /assets 做运行时兼容迁移，旧地址访问会自动回到新地址。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "资产分析页刷新加载优化",
      desc: "资产分析页刷新时原为客户端动态懒加载，首屏先显示「加载中…」几秒；改为 SSR 直出（AssetAnalysisView dynamic ssr:true），服务端首帧直接渲染资产分析内容，避免刷新后整页加载中。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "资产分析趋势图本地缓存无感刷新",
      desc: "资产分析刷新时趋势图和持仓盈亏排行会重新请求历史 K 线，短暂显示「正在汇总真实历史行情…」。现新增 localStorage 趋势缓存：刷新时若持仓、货币、基准一致，先用上次成功趋势/收盘数据立即渲染，再后台刷新更新，避免可见 loading。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "项目与网站品牌统一为 Fire",
      desc: "按用户要求暂时将项目/网站名称统一为 Fire，清理对外展示中的旧品牌名称：package name、默认站点标题/Logo、首页/后台页脚、关于/版本弹窗、桑基图分享品牌、健康检查服务名、财务与名人数据源 UA 等均改为 Fire；内部旧缓存键/事件名/数据库文件名暂不迁移，避免破坏现有数据。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "内部标识与数据库文件名统一迁移为 Fire",
      desc: "在品牌统一为 Fire 的基础上，继续迁移内部标识：localStorage 前缀、全局事件名、会话/主题 Cookie 名、备份文件名、脚本与数据库文件名均改为 fire；旧 localStorage 与 Cookie 做一次性兼容迁移（旧键自动复制到新键后清理，旧会话 Cookie 继续兼容读取），数据库旧文件已备份为 fire-pre-migration.db 后迁移为 fire.db。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "修复登录/注册页与后台路由之间反复刷新",
      desc: "内部会话 Cookie 迁移后，后台布局仍只读取新 fire_session，导致持有旧会话 Cookie 的浏览器在 /login 与 /records 之间反复跳转刷新。修复：后台布局、改密、v1 登出等服务端直接读取会话 Cookie 的位置全部兼容旧会话 Cookie，登录/注册页不再循环刷新。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "修复迁移后股票图标与全球预览加密货币/贵金属缺失",
      desc: "Fire 迁移后排查两处：1) useAssetIcons 本地缓存若为空数组会阻止重新请求 /api/assets，导致自选股/持仓股票图标消失；改为空缓存不生效并强制拉取最新素材。2) 全球预览 market=ALL 现在只返回公司/ETF，缺少加密货币与贵金属；改为在 top-stocks 接口合并素材库 crypto/metal 并按市值排序。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "Fire 迁移连锁问题收尾审计",
      desc: "继续排查 Fire 迁移连锁问题：登录/注册与 v1 登出时同步清理旧会话 Cookie；历史备份目录从旧名改为 fire-*；测试数据文件中的旧邮箱/旧名清理；全项目源码、脚本、文档、数据配置中已无旧品牌标识。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "我的持仓账户资产删除当日盈亏结算提示文字",
      desc: "按用户要求删除我的持仓-账户资产-当日盈亏卡片下方「已结算 · 日期 · 各市场当地结算时点」提示文字，保留当日盈亏金额展示。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "后台左侧导航选中背景改为直接跟随按钮",
      desc: "修复我的持仓、素材库等导航项点击后白色选中背景偏移到下一项的问题：去掉根据索引 translateY 的绝对定位背景，改为每个按钮自身在激活态显示白色背景，避免动态导航顺序/数量变化导致背景错位。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "我的持仓删除按市场汇总提示文字",
      desc: "按用户要求删除我的持仓下「按市场汇总持仓盈亏，币种按各自市场」提示文字，保留持仓盈亏汇总内容。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "首页自选股/我的持仓新增排序",
      desc: "为首页前端「自选股」「我的持仓」表格增加列排序：股票名称、现价、涨跌幅可排序；我的持仓额外支持持仓盈亏排序；点击表头切换升序/降序，第三次点击恢复默认顺序。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "资产分析右侧账户资产净资产标注货币",
      desc: "资产分析右侧账户资产卡片中「净资产」标签增加当前货币后缀，如 净资产(USD)，并跟随货币切换联动为 USD/CNY/HKD。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "账户资产市场筛选按市场币种显示",
      desc: "资产分析右侧账户资产卡片进一步优化：筛选「全部」时仍跟随全局货币切换；筛选美股/港股/A股等具体市场时，净资产标签与金额使用该市场默认货币（US=USD、HK=HKD、CN=CNY，其他市场按 ISO 映射）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "港币账户资产金额缩写防拥挤",
      desc: "资产分析右侧账户资产卡片在港币/人民币显示大额金额时改用「万/亿」缩写（如 HK$66.17万、HK$22.20万），避免 7 列布局中长数字挤压；美元保持原有精确显示。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "美元账户资产金额同样使用万/亿缩写",
      desc: "按用户要求，资产分析右侧账户资产卡片的大额美元金额也统一使用「万/亿」缩写（如 $66.17万），与港币/人民币保持一致的紧凑展示。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "修复美股收盘后盘后涨跌回退错误",
      desc: "美股周末或收盘后若直接回退到腾讯常规盘行情，会把盘后上涨的股票显示成常规盘下跌（如 GOOGL）。修复：闭市/周末也读取 Yahoo 最近一个扩展时段报价，优先展示盘前/盘后最新价与涨跌，避免与盘后真实方向相反。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "美股盘后昨收优先采用腾讯口径",
      desc: "进一步对齐券商盘后盈亏：美股扩展时段覆盖时，昨收价优先使用腾讯行情的昨收，再回退 Yahoo 昨收。修复 AAPU 因 Yahoo 昨收 37.99 与券商 38.00 不同造成的当日盈亏偏差。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享三页卡片统一缩小",
      desc: "资产分析每日盈亏分享弹窗中「盈亏金额 / 持仓列表 / 持仓占比」三页此前高度分别为 830/820/780，切换时卡片大小不一致且整体偏大。现将三页统一为 760px，并压缩头部、金额、列表与环形图的间距和字号。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享卡片进一步精简化",
      desc: "继续缩小每日盈亏分享卡片：宽度由 660 降至 600，高度统一为 700，右侧模板缩略图由 104 降至 88，圆角、间距与头像字号同步收紧，整体更精致。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享卡片支持拖拽缩放与持仓市值隐藏",
      desc: "每日盈亏分享卡片右下角新增拖拽缩放手柄（宽度 420-760、高度 520-900），复制/保存按当前缩放后的卡片尺寸导出；三块顶部的持仓市值增加眼睛按钮，可隐藏/显示金额；持仓列表深色模式白色边框线弱化。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "每日盈亏分享卡片删除顶部持仓市值行",
      desc: "按用户要求删除每日盈亏分享三页共用的顶部「持仓市值：金额」一行，卡片头部只保留头像、昵称与时间。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享图片加载骨架优化",
      desc: "进一步优化分享页面刷新后图片加载慢/空白：模板图预加载改为解码预加载，资产分析页挂载即预热盈利与亏损两套图；分享弹窗图片未就绪时显示轻量骨架占位，解码完成后再显示真实图片，避免空白闪现。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享复制/保存按钮改为底部悬浮胶囊",
      desc: "将复制/保存按钮从右侧工具栏中移出，改为贴在卡片底部边缘的悬浮胶囊按钮，并加入图标+文字；非模板页不再保留空的右侧栏，卡片居中更紧凑。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享复制按钮文案修正",
      desc: "底部操作胶囊中的复制按钮文案由「复制」改为「复制图片」，与保存图片表述保持对称。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享弹窗背景透明度调整",
      desc: "按用户要求将每日盈亏分享弹窗全屏遮罩从接近全黑（93%）改为 30% 黑色透明度，背景内容可见。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享卡片缩放联动全部内容",
      desc: "修复分享卡片拖拽缩放时只有图片跟随变化、文字与盈亏金额不变的问题：卡片内容统一放入基准 600×700 画布并按当前宽高做双轴缩放，拖拽调整卡片大小时文字、金额、图片同步缩放。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享卡片等比例缩放与关闭按钮固定",
      desc: "拖拽缩放改为按百分比等比例调整，左右/上下拖动不再拉伸变形；关闭按钮移出缩放容器并固定在弹窗右上角，缩放时不再随卡片乱跑。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享复制/保存胶囊改为玻璃效果",
      desc: "浅色模式下复制图片/保存按钮由深色胶囊改为半透明白玻璃效果，深色模式保持半透明白玻璃；按钮文字和 hover 态同步适配。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享模板图等待预加载后再打开弹窗",
      desc: "点击分享按钮时先等待固定模板图全部解码完成，再打开每日盈亏分享弹窗；准备期间分享按钮禁用并显示提示，避免打开后图片仍慢慢加载。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "深色模式复制/保存按钮 hover 背景修正",
      desc: "修复每日盈亏分享底部复制图片/保存按钮在深色模式鼠标划过时背景变白的问题，深色 hover 改为半透明白色 10%，不再出现白色块。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享右侧模板缩略图改为六宫格并支持上传",
      desc: "每日盈亏分享右侧缩略图由 5 个改为固定 6 个，缩略图尺寸缩小并适配左侧卡片；第 6 个为相机上传入口，可上传自定义模板并选中用于分享。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "分享右侧缩略图顶部与左侧卡片对齐",
      desc: "右侧六张缩略图改为从顶部开始排列，第一张与左侧卡片顶部对齐；卡片缩放时缩略图随布局同步跟随，不再居中对齐导致错位。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享缩略图支持逐张相机上传",
      desc: "每日盈亏分享右侧六个缩略图每张都增加素材库股票图标同款相机 hover 遮罩，可分别上传自定义图片并自动选中该模板。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "每日盈亏分享顶部页签字号缩小",
      desc: "按用户要求将每日盈亏分享顶部「盈亏金额 / 持仓列表 / 持仓占比」三块文字由 16px 缩小为 14px，视觉更精致。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享卡片缩放自动保存",
      desc: "每日盈亏分享弹窗拖拽缩放后的卡片尺寸自动保存到 localStorage（fire:daily-pnl-share-size），下次打开分享弹窗时恢复上次缩放结果，无需手动确认提示。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "修复分享缩略图无法选中",
      desc: "每日盈亏分享右侧缩略图加相机上传后，上传遮罩用 absolute inset-0 覆盖整张缩略图并拦截点击，导致点击缩略图不再选中模板。改为把相机缩小为缩略图中心的独立小圆标（hover 才显示），点击缩略图主体恢复选中，点击中心相机圆标才上传，两者不再冲突。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "修复每日盈亏分享卡片缩放时突然跳变",
      desc: "修复拖拽缩放手柄放大卡片时突然跳到默认 600×700 的问题：缩放逻辑原先固定以 600/700 为基准（factor=1+delta），未考虑已保存的非默认尺寸，导致开始拖拽的瞬间卡片回跳。改为以当前实际尺寸为基准（baseFactor=当前宽/600）再叠加增量，缩放从当前大小平滑延续。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享持仓列表改为排名 + 四列表格",
      desc: "每日盈亏分享「持仓列表」页由原来的图标+名称+当日盈亏升级为带排名的四列表格：股票图标左侧新增排名序号（第 1 名大号、第 2 名中号、第 3 名及以后小号），右侧新增「成本价 / 现价 / 盈亏额」列，名称列保留股票图标与代码；DailyPnlShareItem 增加 cost / price 字段并复用货币换算。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "持仓列表标题改为股票持仓并改为黑色",
      desc: "按用户要求把每日盈亏分享持仓列表页标题由「当日持仓盈亏明细」改为「股票持仓」，字体颜色由灰色改为黑色（深色模式适配为近白）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "持仓列表排名放大、盈亏率与全部持仓",
      desc: "继续优化每日盈亏分享持仓列表：1) 排名序号改为第 1 名 22px、第 2 名 19px、第 3 名 16px、第 4 名起 13px，均大于数据文字；2) 盈亏额列改为盈亏率（(现价-成本)/成本，盈利红、亏损绿）；3) 去掉原来只展示前 6 条的截断，列出全部持仓；4) 底部「当日持仓合计」改为「持仓盈利」，金额改用持仓总盈亏（summary.pnl）。DailyPnlShareItem 新增 pnl、Props 新增 totalPnl。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "持仓列表成本价改回原币种并优化排版",
      desc: "修复持仓列表成本价/现价被换算成展示货币导致成本价与盈亏率错误的问题：成本价、现价改回股票原币种并按市场显示货币符号（US=$, HK=HK$, CN=¥ 等）；同时放大排名/名称/成本价/现价/盈亏率字体，第 1/2/3 名排名分别用金/银/铜色区分；名称列加宽并允许换行显示完整名称，序号与名称不再拥挤；「股票持仓」标题改为加粗并加渐变下划线。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "持仓列表表头补充序号标签",
      desc: "持仓列表表头第一列由空白占位补上「序号」文字标签，与数据行的排名序号 1/2/3 对齐。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "每日盈亏分享三页标题统一加粗与渐变条",
      desc: "把「盈亏金额」「持仓占比」两页标题也改成与「股票持仓」一致的样式：黑色加粗标题 + 下方渐变彩色短条，三页标题视觉统一。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享标题间距优化与持仓列表滚动条",
      desc: "1) 修复复制/保存图片后标题与渐变彩色短条拥挤的问题：标题去掉过紧的 leading-none 与字距，改为更宽松的行高，短条加高加宽并与标题拉开间距，html2canvas 导出与预览一致；2) 持仓列表新增竖直细滚动条（表头固定，行区域限高滚动），持仓较多时可在分享弹窗内滚动查看。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享标题渐变改为内联样式并提速复制",
      desc: "1) 每日盈亏分享三页标题的渐变彩色短条改用内联 linear-gradient（不含 Tailwind via 自定义变量），标题与短条间距也用内联样式固定，避免 html2canvas 导出时渐变区域和间距与预览不一致；2) 复制/保存图片的 html2canvas 导出倍率由 3 降到 2，显著缩短生成耗时（5-10 秒级降到 1-2 秒级），图片仍为 2 倍高清。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "复制图片导出倍率恢复为 3 倍",
      desc: "按用户反馈 2 倍导出图片偏模糊，将每日盈亏分享复制/保存图片的 html2canvas 导出倍率恢复为 3 倍高清。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "持仓列表去货币符号并加市场徽标",
      desc: "1) 每日盈亏分享持仓列表的成本价/现价去掉货币符号，只保留数字；2) 名称列表头改为「名称/代码」，并在每行代码前增加市场徽标色块：美股 US 蓝色、港股 HK 紫色、A股按代码前缀显示 SH（6/9 开头）或 SZ（其余）红色（色值取自参考图 #e0919f），其他市场用灰色兜底。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "负成本持仓盈亏率显示为横线",
      desc: "修复负成本持仓（如 AAPU、NVDX、SMCX 等摊薄成本后成本为负的持仓）盈亏率显示为负值的问题：盈亏率公式 (现价-成本)/成本 在成本≤0 时无意义，改为成本≤0 时显示「—」，避免误导为亏损。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "持仓列表按盈亏率降序排列",
      desc: "每日盈亏分享持仓列表的排名原来按持仓盈亏额（金额）降序，导致盈亏率更高的股票排在盈亏率更低但金额更大的股票下面；现改为按盈亏率降序排列，与「盈亏率」列一致，成本≤0 的无盈亏率持仓排到最末。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享弹窗关闭按钮移到卡片右上角",
      desc: "每日盈亏分享弹窗的关闭「×」按钮原来固定在浏览器窗口右上角，离卡片较远；现改为定位在卡片右上角上方（右缘与卡片右缘对齐、略高于卡片顶部），并随卡片缩放同步定位。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享标题渐变彩条间距调近",
      desc: "按用户要求把每日盈亏分享三页标题与下方渐变彩色短条的间距由 12px 调整为 8px，让彩条更靠近标题文字；复制图片与保存图片按钮保持不变。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享页与导出图标题彩条间距解耦",
      desc: "把每日盈亏分享标题渐变彩条改为块级元素，分享页显示间距调近到 4px；复制/保存图片导出时通过 renderCard 临时把彩条间距固定为 12px，导出完成后恢复，确保导出图的彩条间距不被分享页显示调整影响。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享卡片垂直居中显示",
      desc: "每日盈亏分享弹窗的卡片原为顶部对齐，现将卡片区域改为垂直居中（items-center），卡片在页签栏下方剩余空间内上下居中显示。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享页签与卡片整体居中",
      desc: "修复上一步居中后顶部「盈亏金额 / 持仓列表 / 持仓占比」三个页签没有跟随的问题：把页签栏与卡片放入同一个 flex 列并整体垂直居中，卡片从 flex-1 改为内容自适应，页签与卡片作为一个整体在页面中上下居中。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "盈亏金额卡片位置与其他页签保持一致",
      desc: "盈亏金额页因右侧多出模板缩略图列，卡片会相对持仓列表/持仓占比向左偏移，来回切换时卡片位置跳动。现把外层定位容器宽度固定为卡片宽度（shareWidth），模板缩略图向右溢出显示，卡片始终保持居中、与另外两页位置一致。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "盈亏金额页标题精简为当日持仓盈亏",
      desc: "按用户要求把每日盈亏分享「盈亏金额」页标题由「当日持仓盈亏金额」改为「当日持仓盈亏」。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "持仓占比页标题精简为持仓分布",
      desc: "按用户要求把每日盈亏分享「持仓占比」页标题由「当前持仓资产分布」改为「持仓分布」。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "盈亏金额页标题再精简为当日盈亏",
      desc: "按用户要求把每日盈亏分享「盈亏金额」页标题由「当日持仓盈亏」改为「当日盈亏」。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "修复持仓列表导出图代码与市场徽标截断",
      desc: "每日盈亏分享持仓列表导出图（html2canvas）中，名称/代码列的市场徽标（US/HK/SH/SZ）与代码文字出现垂直截断、徽标与代码过近。修复：代码行去掉过紧的 leading，改为固定 16px 行高，代码文字用 min-w-0 + truncate 并加足行高，市场徽标与代码间距由 4px 加大到 6px，导出图不再裁切。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "继续修复市场徽标与代码垂直截断",
      desc: "上一版市场徽标与代码在导出图中仍显示下半截被裁掉。继续修复：去掉代码文字的 truncate/overflow-hidden（避免 html2canvas 按内容盒垂直裁切），市场徽标放大到 18px 高并统一 18px 行高，代码文字也使用 18px 行高且不再裁切，徽标与代码显示完整。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "市场徽标与名称/代码改用块级布局",
      desc: "持仓列表导出图中市场徽标仍与上方股票名称重叠、且底部显示不全，原因是嵌套 flex/inline-flex 在 html2canvas 中渲染不稳定。改为块级 + inline-block 布局：名称固定 20px 行高，下方 6px 间距后接市场徽标与代码（均 18px 高、行高 18px），徽标使用明确 padding/背景/字号，代码与徽标垂直对齐，导出图不再重叠或裁切。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "市场徽标去掉固定高度改用 padding 自适应",
      desc: "持仓列表导出图中 SH/SZ 等市场徽标文字仍显示下半截被切掉。根因是 inline-block 上同时设置固定 height 与 lineHeight，html2canvas 计算文字垂直居中不稳定。改为去掉固定 height，用上下 padding + 12px 行高自适应撑起 18px 高的徽标，文字完整显示；代码保持 18px 行高并与徽标顶部对齐。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "市场徽标改用 SVG 渲染彻底修复裁切",
      desc: "市场徽标此前用 HTML+CSS 背景色渲染，在 html2canvas 导出图中反复出现底部缺失/文字裁切。现改为内联 SVG（圆角矩形 + 居中文字），html2canvas 对 SVG 按图像渲染稳定，徽标不再被裁切；同时把名称与徽标间距由 6px 加大到 12px，徽标与代码间距由 6px 加大到 8px。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "市场徽标与上方名称间距精调",
      desc: "按用户反馈把市场徽标与上方股票名称的间距由 12px 精调为 8px，取 6px（过近）与 12px（过远）之间的合适间距。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "市场徽标间距改为分享页 6px",
      desc: "明确用户说的是分享页显示而非导出图后，把市场徽标与上方股票名称间距进一步收紧为 6px；此前「过近」是导出图 HTML 徽标重叠导致，改用 SVG 后导出已稳定，6px 在分享页与导出图均合适。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "市场徽标间距分享页与导出图解耦",
      desc: "分享页市场徽标与名称间距保持 6px（预览合适），导出图因 html2canvas 对行高/文字基线渲染差异导致徽标偏近，现 renderCard 截图前临时把徽标行间距调到 10px，导出完成后恢复，找到导出图不远不近的平衡点。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "分享页名称与市场徽标间距继续收紧",
      desc: "分享页股票名称与市场徽标仍显偏远：把名称行高由 20px 收紧为 18px、名称到徽标间距由 6px 收紧为 4px，视觉间距更紧凑；导出图徽标行距仍保持 10px 的截图覆盖。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导出图市场徽标与代码垂直对齐",
      desc: "导出图（html2canvas）中市场徽标 SVG 因未显式声明 CSS 宽高，渲染高度与代码行高不一致，导致徽标偏上、与股票代码不在同一水平线。给徽标 SVG 补上显式 CSS width/height 30×18px 并保持 vertical-align:top，导出图徽标与代码同一水平线。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导出图徽标文字与代码文字精确对齐",
      desc: "导出图中徽标整体仍与代码底部对齐，导致徽标内文字比代码文字偏高约 3-5px。因 html2canvas 未按 vertical-align:top 对齐 SVG，改为截图时给市场徽标 SVG 临时加 translateY(4px) 下移，使徽标文字与代码文字处于同一水平线，截图后恢复。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导出图市场徽标与名称间距对齐分享页",
      desc: "资产分析分享导出图中市场徽标行仍过于贴近上方股票名称，原因是 html2canvas 对徽标行 marginTop 的渲染与浏览器不一致。修复：renderCard 截图前临时把徽标行 marginTop 由 4px 提升到 12px，截图后恢复，使导出图徽标与名称间距与分享页一致。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导出图徽标改用占位块保证间距",
      desc: "继续修复导出图市场徽标仍偏上贴紧名称：html2canvas 对徽标行 marginTop 的渲染不可靠。改为截图时把徽标行 marginTop 置 0，并在其上方插入一个固定 10px 高的占位 div（截图后移除），用块级高度确定性撑开间距，使导出图徽标与名称距离与分享页一致，分享页不受影响。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导出图徽标行改为 flex 渲染并保距",
      desc: "进一步修复导出图市场徽标仍偏上：徽标行使用 display:grid，html2canvas 1.4.1 不实现 grid 布局，导致导出图中徽标/代码排列与间距异常。改为截图时临时把徽标行切换为 flex（徽标 30×18 不收缩、代码 flex:1 左间距 8px），并在上方插入 10px 占位块，截图后恢复全部内联样式；分享页仍用原 grid 布局不受影响。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导出图徽标占位间距调至 16px",
      desc: "按用户反馈导出图市场徽标仍需继续下移，把截图时徽标行上方占位块高度由 10px 提升到 16px，徽标与名称间距进一步拉开；分享页不变。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导出图徽标与代码改用表格布局对齐",
      desc: "修复导出图市场色块与股票代码的对齐：html2canvas 1.4.1 不实现 flex/grid 布局，改用 display:table + table-cell + vertical-align:middle 渲染徽标行（截图时临时切换，截后恢复），徽标与代码垂直居中对齐、色块完整显示、代码左侧保持 8px 与分享页一致；分享页仍用原 grid 布局不受影响。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导出图徽标下移对齐代码文字",
      desc: "继续修复导出图市场色块仍偏上：徽标 SVG 在 table-cell 内用 translateY(4px) 下移（色块底部可超出但完整显示），使色块文字与右侧股票代码文字对齐；截图后移除包裹层并恢复样式，分享页不变。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导出图徽标下移量收敛到 2px",
      desc: "按用户反馈 4px 下移后偏下，将导出图徽标 SVG 的 translateY 从 4px 收敛到 2px，取 0（偏上）与 4（偏下）之间的临界点。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导出图徽标行加高避免底部被裁",
      desc: "徽标 translateY(2px) 下移后底部超出 18px 表格行被 html2canvas 裁掉。保持徽标位置不变，把导出时徽标行高度由 18px 加到 20px，让色块完整显示不被遮挡。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "复制图片时分享卡片不再跳动",
      desc: "此前导出前的样式覆盖（表格布局、占位块、translateY 等）直接改实时 DOM，复制图片瞬间列表会跳动。改为把这些覆盖全部放进 html2canvas 的 onclone 回调，只在克隆文档里生效，实时 DOM 零改动，复制/保存图片时分享页无任何跳动。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "持仓列表第七行完整显示",
      desc: "持仓列表限高 360px 时第 7 行底部被裁掉几个像素，把列表 max-height 由 360px 提高到 410px，第 7 行整排完整显示，底部持仓盈利汇总仍可见。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "持仓列表可见 7 行且可滚动",
      desc: "按用户要求持仓列表保留全部持仓，可视区固定约 7 行（max-height 404px），超出部分通过滚动条下拉查看；此前误把列表截断为 7 条已恢复为全部。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "持仓列表可视区精确 7 行",
      desc: "表头在滚动容器之外，max-height 只约束数据行；404px 时第 8 行的序号 8 仍露出。按 7×52px 精确调整为 364px，可视区刚好 7 行完整显示，第 8 行不再露出，滚动条可下拉查看更多。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "持仓列表表头字号放大",
      desc: "按用户要求把股票持仓下方表头一行（序号 / 名称/代码 / 成本价 / 现价 / 盈亏率）字号由 12px 放大到 13px。tsc 无错误、npm run build 通过。",
      kind: "fix"
    }
  ]
};

export const V0_1_11_ENTRY: VersionEntry = {
  ...V0_1_9_ENTRY,
  version: "v0.1.11",
  date: "2026-08-18",
  summary: "左上角 FIRE 字标改用 kiro.dev 同款字体（AWS Diatype Rounded Semi Mono Bold），字体文件本地化，深浅色模式一致。",
  software: V0_1_9_ENTRY.software.map((item) =>
    item.name === "Fire" ? { ...item, version: "v0.1.11" } : item
  ),
  changes: [
    {
      title: "FIRE 字标换用 kiro.dev 同款字体",
      desc: "按参考把左上角品牌字标由系统粗体换成 kiro.dev 左上角 KIRO 使用的 AWS Diatype Rounded Semi Mono Bold（700，19px 下比 Regular 更有存在感）：字体文件从 kiro.dev 本地化到 public/fonts（woff2，Regular 400 同时保留），globals.css 新增 @font-face，Tailwind 增加 font-logo 字体族；应用范围：后台/首页左上角 LOGO 文字（SiteLogo 与首页 Logo）、登录页桌面与移动端品牌文字。深浅色共用同一字体，颜色仍跟随 text-ink（浅色深字、深色浅字）。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "Logo 字体可在设置中切换 + 网站形象一键重置",
      desc: "设置 → 网站形象 → Logo 字体新增三个选项：KIRO 同款·粗体（默认）/ KIRO 同款·常规 / 系统粗体，选择后立即预览、保存后全站左上角 LOGO（后台、首页、登录页）同步生效；新增 logoFont 设置项（类型、默认值、保存/公开接口 v1/v2 全链路）；网站形象区块新增「重置」按钮（二次确认），一键把网站图标、Logo 图片、Logo 文字、Logo 字体、网站背景恢复默认并保存。tsc 无错误。",
      kind: "feature"
    },
    {
      title: "修复美东夜盘结束后当日盈亏仍显示昨日的问题",
      desc: "美东夜盘（20:00-04:00）结束后进入盘前，当日盈亏此前仍停留在上一交易日：1) 盘前/盘后基准价错误——应用优先采用腾讯「昨收」，而盘前刚开始时腾讯仍返回更早收盘（实测美股盘前 04:08 腾讯昨收还是上周五收盘，Yahoo regularMarketPrice 才是最近常规收盘），导致盘前涨跌把昨日涨跌混入；2) 盘前尚无成交时 Yahoo 无当日盘前点，扩展行情整批失败退回腾讯昨收，当日盈亏直接显示昨日。修复：扩展时段统一以 Yahoo regularMarketPrice（最近常规收盘）为基准；盘前暂无成交时返回「基准价 + 当日盈亏归零」，不再沿用昨日。实测 AAPL 盘前 prevClose 305.93→305.59、涨跌 +0.31→+0.51，SACH 无盘前成交显示 0。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "行情源接入富途 OpenAPI（OpenD 网关，全局优先 + 自动回退）",
      desc: "按用户要求评估并接入富途接口：安装 Futu_OpenD（GUI 10.10.7008）与 futu-api Python SDK，新增 scripts/futu_quotes.py 桥接脚本（get_market_snapshot / get_search_quote），Node 侧新增 lib/futuQuotes.ts（端口预检 + 可用性缓存 + 美股盘前/盘后/夜盘 session 提示）。行情与搜索全局改为富途优先：快照直接覆盖腾讯+Yahoo（含 pre_price / after_price / overnight_price 盘前盘后夜盘三档涨跌），搜索走 get_search_quote；OpenD 未安装/未登录/失败时自动回退腾讯+Yahoo+东财，不影响现有功能。健康检查新增 quoteSource 与 futuOpenD 状态。登录 OpenD 后即为全局主行情源。tsc 无错误。",
      kind: "feature"
    },
    {
      title: "行情源手动切换（自动 / 仅富途 / 腾讯+Yahoo）",
      desc: "按用户要求把备用切换做成可配置：设置 → 股票来源接口 → 行情源新增三个选项——自动（富途优先，失败回退腾讯+Yahoo，默认）/ 仅富途 / 腾讯+Yahoo；新增 quoteSource 设置项（类型、默认值、保存接口白名单校验、加载归一化），行情与搜索均按该配置决定是否启用富途，强制富途时不再回退备用源；股票来源接口区块顶部显示富途 OpenD 连接状态（已连接走富途 / 未连接走备用源），健康检查返回 quoteSource 与 effectiveSource 两个字段。tsc 无错误、端到端实测保存/还原正常。",
      kind: "feature"
    },
    {
      title: "富途 OpenAPI 连接配置进系统设置 + 新增「交易」区块",
      desc: "为线上部署做准备：富途 OpenD 网关地址不再写死本机，新增 futuHost / futuPort 设置项（默认 127.0.0.1:11111，可指向远程 OpenD；类型、默认值、保存接口校验、加载归一化全链路）；设置 → 我的持仓（stocks）新增「交易」区块，内含两块独立卡片——「富途 OpenAPI 配置」（主机 + 端口 + 测试连接按钮，真实拉一次 AAPL 快照验证可达与登录）+「行情源」切换（自动 / 仅富途 / 腾讯+Yahoo，从股票来源接口移入）；股票来源接口不再包含行情源；新增 POST /api/futu/test 连接测试接口（管理员，支持临时 host/port）；健康检查按已保存配置检测。tsc 无错误、保存/还原/测试接口实测正常。",
      kind: "feature"
    },
    {
      title: "修复富途测试连接：OpenD 绑定局域网地址 + SDK 日志污染 stdout",
      desc: "OpenD 登录后设置页测试连接仍失败，排查到两个原因：1) 本机 OpenD 配置的监听地址是局域网 IP localhost 而非 127.0.0.1（OpenD.xml 中 ip/telnet_ip/websocket_ip 均绑定该地址），默认主机配置连不上——已将 futuHost 设置项更新为实际监听地址，并在配置说明里提示局域网地址场景；2) 富途 SDK 的 FTConsoleLog 默认把日志打到 stdout，混入桥接脚本 JSON 导致 Node 解析失败——桥接脚本静默 console logger，Node 侧解析改为只取首个 { 到最后一个 } 的 JSON 片段。修复后实测：测试连接 0.7s 返回成功（AAPL 305.59）、行情全局切富途（AAPL 盘前 307.91 / +2.32 / prevClose 305.59）、健康检查 effectiveSource=futu。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "设置页 2.0 重构：⌘K 命令搜索 + 全局自动保存 + 极简双栏布局",
      desc: "按用户要求用前沿交互重构臃肿的设置页：1) 删除大尺寸 hero 卡、竖/横排切换与各模块零散保存按钮，改为紧凑顶栏（标题 + 全局保存状态胶囊 + 版本徽标）；2) 新增 ⌘K 命令搜索——输入 Logo / 富途 / 数据库 / 密码等关键词即时匹配 12 个设置项，方向键 + 回车或点击跳转到对应模块并高亮定位；3) 全局自动保存（React 19 风格）：站点信息、网站形象、首页指数、首页导航、股票来源接口、交易（富途 + 行情源）等 22 个字段修改即保存，700ms 防抖，顶栏实时显示「保存中… / 已保存 HH:MM / 保存失败·重试」，失败可一键重试；4) 左侧导航改为极简图标栏（激活态高亮），移动端保留横向胶囊；5) 券商管理因含「清空二次确认」保留独立保存按钮，数据库配置保留显式保存，其余全部自动保存。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "设置改为独立桌面窗口（弹窗式）+ 右上角齿轮入口 + 深浅色跟随主题",
      desc: "按用户最终选定的桌面客户端布局（V16/V17）落地：1) 设置从页面页签改为独立弹窗窗口（SettingsWindow：960×720 居中、窗口标题栏红绿灯 + Fire 设置 + 版本、底部状态栏显示富途 OpenD/行情源/自动保存），从任意页面点右上角齿轮或导航「设置」都能打开，Esc / 红点 / 点击遮罩关闭；2) 深色/浅色随右上角主题切换自动变化（同一份样式，不再固定单主题）；3) 窗口内布局改为紧凑桌面风格——184px 侧栏（搜索设置按钮 + 分组导航 + 底部管理员）+ 主区行式设置项（站点信息、交易·富途等改为「名称在左、控件在右」行式面板），⌘K 搜索保留在内容区顶部；4) 导航「设置」页签点击直接开窗，不再切换页面内容。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "设置入口改为左下角常驻头像（桌面客户端风格），移除导航「设置」页签",
      desc: "按用户要求彻底桌面客户端化：1) 移除侧边导航与移动端导航里的「设置」页签（默认页签数组、设置页导航菜单编辑、加载归一化全部过滤掉，历史数据库里残留的设置页签也不再显示）；2) 新增左下角常驻头像入口——圆形头像（真实头像或首字 + 右下角小齿轮角标），悬浮于页面左下角，点击打开设置窗口，任意页签可用；3) 右上角头像菜单里的「设置 / 个人信息」也统一改为打开设置窗口（个人信息定位到 profile 子页），不再跳转页面；4) /settings 深链直接开窗并落在默认页签，设置子分类导航只在窗口内切换，不再影响主页面内容。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "设置窗口搜索去重 + 左下角改齿轮图标 + 窗口内头像补真实头像与在线点",
      desc: "细节收尾：1) 设置窗口原来有「侧栏搜索按钮 + 内容区搜索框」两个搜索，删掉内容区第二个，只保留左上角侧栏顶部一个「搜索设置」，点击展开下拉搜索面板（⌘K 快捷键同步可用）；2) 页面左下角常驻入口由头像改为设置齿轮图标（圆形按钮 + 齿轮，悬停放大），不再占用头像语义；3) 设置窗口左下角侧栏底部的用户头像改为显示真实头像（有 user.avatar 用图片，无则首字兜底），并在头像右下角边框处加绿色在线状态点（深浅色边框适配）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "设置由弹窗式改为页面内无感平滑过渡",
      desc: "按用户要求去掉弹窗形态：删除 SettingsWindow 弹窗壳与齿轮弹窗入口，设置恢复为页面内页签内容（桌面客户端式紧凑侧栏 + 行式设置项保留），点左下角齿轮或头像菜单「设置 / 个人信息」时在当前页面内无感切换并带平滑淡入过渡（tab-panel 已有的 fade + 上移动画，prefers-reduced-motion 自动降级），不弹窗、不跳转、不刷新；/settings 深链直接落在设置页签。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "设置页恢复客户端边框卡片（保持原有尺寸不变）",
      desc: "按用户反馈修复页面内设置页卡片视觉：1) 设置页内容区加客户端底色（浅色 #f3f3f3 / 深色 #1c1c1c），让卡片与页面区分开；2) 设置分组卡片保持原有尺寸/内边距/圆角不变（撤销此前 12px 紧凑内边距、34px 输入框、按钮缩小等尺寸改动），仅加强可见性——浅色白底 + 细边框 + 轻阴影，深色深底 + 边框 + 阴影；3) 外层设置卡片容器原样保留。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "澄清设置形态：仅去掉弹窗遮罩，960px 客户端窗口壳页面内嵌、宽度不变",
      desc: "按用户纠正：之前误把设置改成铺满页面的宽布局。修正为——只移除弹窗的遮罩/悬浮/居中定位，桌面客户端窗口壳原样保留并直接嵌进页面内容区：固定 960px 宽（max-w-[960px] 居中）、720px 高（小屏自适应）、窗口标题栏（红绿灯 + Fire 设置 + 版本）、紧凑侧栏、行式设置卡片、底部状态栏全部不变；进入设置带平滑 pop-in 过渡，宽高与弹窗版一致，不再变宽。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "设置加回导航页签 + 移除左下角设置图标",
      desc: "按用户要求：1) 「设置」页签重新加回桌面侧边导航与移动端导航（默认页签、导航菜单编辑、服务端加载归一化均恢复，历史数据缺设置页签时自动补上），点击后仍以 960px 客户端窗口壳在页面内平滑呈现；2) 移除左下角常驻齿轮设置图标，设置入口统一走导航「设置」页签与右上角头像菜单。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导航页签可拖动排序并自动保存，「设置」默认在最左边",
      desc: "按用户要求：1) 桌面侧边导航页签支持鼠标拖动排序（cursor-grab，拖到目标位置松手即重排），顺序变化自动保存到 site_settings.tabs 并全局生效（刷新/换设备保持）；2) 默认顺序调整——「设置」页签排在导航最左边（默认页签数组三处、服务端缺省补齐逻辑均改为 settings 在首位，当前数据库已迁移为 settings 在第一位）；3) 移动端标签栏保持静态顺序跟随。tsc 无错误、npm run build 通过、端到端实测保存/还原正常。",
      kind: "feature"
    },
    {
      title: "设置窗口壳可拖动 + 默认靠左；撤销「设置页签默认最左」",
      desc: "按用户要求调整：1) 设置 960px 客户端窗口壳支持按住标题栏拖动（pointer capture，光标变为 move，拖动过程中实时跟随、上下左右不越界），位置自动保存到 localStorage（fire:settings-window-pos），默认位置为最左边（x:0,y:0，不再居中）；2) 撤销上一条「设置页签默认最左边」——默认页签顺序与缺省补齐逻辑恢复为 settings 在末尾，当前数据库导航顺序已还原（holdings…activities, settings），导航页签拖动排序 + 自动保存功能保留。tsc 无错误、npm run build 通过、端到端实测顺序保存/还原正常。",
      kind: "fix"
    },
    {
      title: "日志 / 附件管理 / 用户管理 / 名人持仓统一套用设置页客户端窗口风格",
      desc: "抽出通用 ClientWindow 组件（960px 窗口框架 + 红绿灯标题栏 + 标题/徽标 + 可选底部状态栏 + 可选拖动），设置窗口改为基于它实现；日志、附件管理、用户管理、名人持仓四个视图在 RecordsApp 里全部用 ClientWindow 包裹，居中显示，与设置页同款边框/圆角/阴影/进入动画，保持桌面客户端统一观感（权限守卫逻辑不变）。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "修复设置窗口可拖动与默认靠左未生效",
      desc: "排查并修复：1) 拖动改为 mousedown + window mousemove/mouseup（弃用 pointer capture），拖动更可靠，且位置用 ref 实时镜像，松手时保存最新位置；2) 位置恢复从 useState 初始化改为挂载后 useEffect 读取，避免水合不一致导致交互失效；3) 本地位置校验（非法/越界自动回 0,0）；4) 存储键升级为 fire:settings-window-pos:v2，清除旧版残留位置——本次更新后首次打开设置窗口必然落在最左边 (0,0)，之后拖动的位置才被记住。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "恢复至 20:36 状态（撤销四个视图套窗口壳）",
      desc: "按用户要求恢复到 20:36 的状态：移除通用 ClientWindow 组件与「日志 / 附件管理 / 用户管理 / 名人持仓」的客户端窗口壳（四个视图恢复为原有独立页面）；设置窗口恢复为独立的 960px 页面内嵌窗口壳（标题栏红绿灯 + Fire 设置 + 版本 + 底部状态栏），按住标题栏可拖动、默认靠左、位置自动保存（保留可靠版拖动实现，避免拖不动）；导航页签可拖动排序 + 自动保存、「设置」页签位于末尾、左下角无齿轮图标等均保持恢复点状态。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "用户管理：按 UID 排序 + 进入秒开（缓存 + 即时渲染表壳）",
      desc: "1) 排序：/api/users 由 created_at 升序改为按 UID 数字升序（CAST(uid AS INTEGER)），测试账号（无 UID）固定排在最后，实测 admin(1) → demo(2) → 测试账号；2) 加载优化：进入用户管理不再整页「加载中…」——新增模块级 5s 短缓存（切页秒开、先渲染表壳再后台刷新），首次加载也在卡片内显示小型加载行而不是整页占位；编辑/重置密码/删除/手动刷新后强制重新拉取。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "设置窗口右上角新增版本切换（V1 / V5 / V7 / V14）",
      desc: "按用户要求在设置窗口标题栏右上角（v0.1.11 徽标旁）新增版本切换 icon（调色盘+时钟），点击弹出菜单含 V1 富途橙 / V5 Notion / V7 Claude / V14 桌面客户端 四个版本（每项带三段色卡预览 + 当前项对勾）；选中后设置窗口整体换肤——窗口壳（标题栏/侧栏/状态栏/卡片/输入框/文字/强调色/标题字体）改为 CSS 变量驱动，四套版本各自定义完整配色（V1 深蓝侧栏+橙、V5 白底极简黑、V7 暖米+陶土橙+衬线标题、V14 深色+淡紫强调），选择持久化到 localStorage（fire:settings-version），默认 V14。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "版本切换适配浅色 / 深色主题",
      desc: "修复版本换肤与右上角主题切换不联动的问题：四个版本（V1/V5/V7/V14）各自定义完整的浅色与深色两套 CSS 变量——浅色主题下用各版本浅色系（V14 白底黑强调、V1 浅灰+橙、V7 暖米+陶土橙、V5 纯白极简），切到深色主题后自动切换各版本深色系（V14 深灰+淡紫、V1 深蓝+橙、V7 暖黑+陶土橙、V5 近黑极简）；窗口壳、卡片、输入框、文字、边框、强调色、下拉菜单全部跟随变量联动。tsc 无错误、npm run build 通过。",
      kind: "fix"
    }
  ]
};

export const V0_1_12_ENTRY: VersionEntry = {
  ...V0_1_9_ENTRY,
  version: "v0.1.12",
  date: "2026-08-19",
  summary: "版本切换对齐各版本 mockup：V14 补底部随心输入条与最近编辑、颜色对齐；V1 站点信息/交易改卡片式双列字段；V5/V7 补齐细节；全部适配浅色/深色。",
  software: V0_1_9_ENTRY.software.map((item) =>
    item.name === "Fire" ? { ...item, version: "v0.1.12" } : item
  ),
  changes: [
    {
      title: "版本切换对齐 mockup：V14 / V1 修复 + V5 / V7 细节补齐",
      desc: "按用户反馈让四个版本贴近交付的 HTML 预览稿：1) V14——深色配色对齐 HTML（窗口 #181818、卡片 #2a2a2a、输入 #2b2b2b、边框 #35353f），底部补上与 HTML 一致的「随心输入」命令条（+ 按钮 + 搜索 + 自动保存开 ⌘K，仅 V14 显示），侧栏补「最近编辑」分组（仅 V14 显示）；2) V1——站点信息与交易（主机/端口）改为 HTML 里的卡片式双列字段（label 在上、输入在下，2 列网格），侧栏隐藏图标贴近 HTML，强调色/按钮用橙色；3) V5 Notion——分组卡片去重阴影、细圆角、页头字号贴近 HTML；4) V7 Claude——页头与分组标题改用衬线字体（Georgia）贴近 HTML；五个（含深浅色）全部继续跟随右上角主题。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "V7 侧栏浅暖色对齐 + V1 侧栏图标恢复 + 各版本侧栏 Logo",
      desc: "继续打磨细节：1) V7 Claude——侧栏由深暖色修正为 mockup 的浅暖米色（#fbfaf6），激活导航项用珊瑚色（#b4633f），页头字号放大（22px 衬线）；2) V1 富途橙——恢复侧栏导航图标（此前误隐藏，mockup 有 16px 图标且激活态橙色）；3) 四个版本侧栏顶部统一补 Logo：V1 橙 F 渐变圆角、V7 珊瑚 C 圆形（带光晕）、V5 黑 F 方块（名称显示 Fire 设置）、V14 淡紫 F + 设置中心标签，全部跟随版本配色与深浅色。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "V1 浅色侧栏搜索按钮去白底",
      desc: "V1 浅色模式下侧栏「搜索设置」按钮此前误用浅色输入框变量呈现白底，在深蓝侧栏上突兀；改为贴合 mockup 的深色按钮（#232a38 底 + 深边框 + 浅灰字，悬停白色），内部 ⌘K 徽标同步深色。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "V1 侧栏悬停文字可见性修复",
      desc: "V1 浅色模式下侧栏为深蓝底，但悬停/底部/Logo 名称仍用浅色主题的深色文字，深字压深底看不见。修复：V1 侧栏上的文字统一浅色——导航项悬停变白、分组标题浅灰、底部管理员名字浅白、Logo 名称白色。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "搜索框上方新增 Fire 发光流光字标（对齐 KIMI 视频效果）",
      desc: "按用户分享的 KIMI 视频（文字呼吸发光 + 流光）在设置窗口侧栏搜索框上方制作动态 Fire 字标：字体加粗放大 + 背景渐变换色流光（background-clip: text）+ 呼吸辉光（drop-shadow 强弱脉动），四套版本各自配色（V14 白底淡紫流光、V1 白橙红火焰渐变、V7 衬线暖橙、V5 极简灰黑），跟随深浅色主题，prefers-reduced-motion 自动停用动画。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "搜索框上方只保留小写 fire 发光字标",
      desc: "按用户要求精简：侧栏搜索框上方只保留小写「fire」发光流光字标，去掉 logo 圆标（F/C 色块）与「设置中心」标签，V5 的「Fire 设置」后缀一并移除，仅剩动态小写 fire。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "fire 字标居中 + 标题栏去掉「Fire 设置」文字",
      desc: "1) 侧栏搜索框上方的小写 fire 发光字标改为水平居中；2) 设置窗口标题栏（红绿灯右侧）删除「Fire 设置」文字，只保留版本切换图标与版本号，界面更干净。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "V1 深色右侧内容区去蓝调",
      desc: "V1 深色模式下右侧内容区此前偏蓝（#1b2230 蓝灰），改为中性深灰（内容 #1c1c1f、卡片 #232327、边框 #2e2e34），文字同步提亮保证对比度；保留深蓝侧栏与橙色强调的 V1 特征。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "设置页版本切换图标美化",
      desc: "设置窗口右上角版本切换图标由「时钟+圆点」改为更精致的「三层叠加图层」图标（寓意版本堆叠），并改用各版本强调色显示（V1 橙 / V7 珊瑚 / V14 淡紫 / V5 黑），悬停回主题文字色。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "设置侧栏导航图标整体美化",
      desc: "设置窗口左侧导航图标换新：统一 1.8 线宽、圆头圆角风格——网站设置用调节滑杆、股票设置用蜡烛图、个人信息用用户、数据库增强用柱体、定时任务用时钟、API 用代码括号、关于用信息圆；搜索命令面板结果项同步使用同一套图标。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "设置侧栏图标升级为 macOS 质感（圆角底块 + 1.5 细线）",
      desc: "继续打磨精致度：导航图标线宽降为 1.5、几何比例重新校准，并放入 26px 圆角底色块（浅灰/深色半透明底）呈现 macOS 系统设置质感；激活项底块用版本强调色实心 + 反色图标（V1 橙底 / V7 珊瑚底 / V14 淡紫底 / V5 黑底），悬停时图标提亮。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "恢复侧栏图标为原版（撤销图标重绘与底块样式）",
      desc: "按用户反馈撤销两轮图标改动：移除自定义 swNavIcon 与 macOS 圆角底块样式，设置侧栏导航与搜索命令面板恢复使用原有 SubNavIcon 图标（14px/12px），回到改动前的观感。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "修复「网站设置 / 关于」图标重复 + 图标唯一性写入规范",
      desc: "根因：SubNavIcon 对未注册的 key（关于）会静默回退成 site 地球图标，导致「网站设置」与「关于」重复。修复：ICON_PATHS 新增 about 专属图标（信息圆），两个条目图标不再相同；并在 AGENTS.md「交互与适配约定」新增图标唯一性规范——新增导航/设置项必须先注册专属图标，禁止依赖 site 回退，新增后全站走查确认每个 key 形状互不相同。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "去掉设置侧栏与内容区之间的边框",
      desc: "按用户截图标注去掉设置窗口侧栏右侧的竖边框（border-r），侧栏与内容区仅靠底色区分，整体少一层边框更清爽。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "去掉标题栏下方与状态栏上方的横线",
      desc: "按用户确认的位置去掉设置窗口两条横线：标题栏底部边框（border-b）与状态栏顶部边框（border-t），窗口更轻盈；此前误删的侧栏右边框已恢复。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "V14 底部命令条改为与其它版本统一的状态栏",
      desc: "V14 原本用「随心输入」命令条作底部，与 V1/V5/V7 的状态栏不一致；改为所有版本统一显示常规状态栏（富途 OpenD 连接状态 · 行情源 · 修改自动保存），删除命令条相关样式。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "恢复标题栏下方与状态栏上方的横线",
      desc: "按用户要求恢复设置窗口标题栏底部边框（border-b）与状态栏顶部边框（border-t）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "去掉「网站设置 · 修改自动保存」下方第一个内容外框的边框",
      desc: "按用户指认的位置（内容头部下方包着全部设置分组的大框）去掉其边框与阴影：各设置子页内容容器由「rounded-card border bg-white shadow-card」改为仅保留底色与内边距，内容与窗口融为一体，只保留内部分组卡片边框。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "设置子项重塑：整块面板 + 分组标题 + 细分隔行（参考 Linear / macOS）",
      desc: "按用户要求参考主流网站重新设计设置子项，解决「太乱」：1) 去掉每组分组的独立卡片边框/底色，内容区变成一整块面板，分组之间仅靠「小号灰色分组标题」区分（Linear / macOS 设置风格），行与行保留细分隔线；2) 分组标题图标隐藏，标题改为 12px 灰字分组标签，动作按钮（重置等）保留在行尾；3) 图片类设置项（网站图标 / Logo / 网站背景）默认收起为紧凑行（标签 + 缩略预览 + 更换按钮），点「更换」才展开 上传 / 粘贴直链 / 清除 / 打开 面板，不再默认铺开；4) 股票来源接口 URL 卡片自动识别 http(s) 并出现「打开链接」。全部跟随版本配色与深浅色。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "设置改为富途 macOS 桌面端风格（顶部 Tabs + 无侧栏 + 分组行）",
      desc: "按用户提供的富途 macOS 截图重塑设置窗口布局：1) 去掉左侧栏，子分类改为顶部横向 Tabs（网站设置 / 股票设置 / 个人信息 / 数据库增强 / 定时任务 / API / 关于），激活项文字高亮 + 强调色下划线（富途 macOS 的「常规/行情/交易/提醒/热键/安全」同款）；2) 顶部左侧保留发光小写 fire，右侧搜索图标（⌘K 弹层）+ 保存状态；3) 内容区去掉大面板底色，分组标题 + 紧凑行直接铺在窗口背景上，行间细分隔线，图片类设置项保持「收起 → 更换展开」；4) 移动端顶部 Tabs 横向滚动自适应。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "恢复设置窗口为左侧栏布局（撤销富途 macOS Tabs 改动）",
      desc: "按用户要求撤销富途 macOS 顶部 Tabs 方案，恢复为上一版布局：左侧栏（fire 发光字标 + 搜索设置 + 分组导航 + V14 最近编辑 + 底部用户头像在线点）+ 内容头部（设置 / 子分类 · 修改自动保存 + 保存状态）+ 分组标题行式内容；删除顶部 Tabs 与搜索图标相关样式，分组行 / 媒体字段收起展开等此前优化保留。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导航菜单中「我的持仓」前面的图标删除（设置页导航菜单编辑器 + 主侧栏）",
      desc: "按用户要求删除「我的持仓」前的图标：1) 设置页「导航菜单」编辑器行内首字图标对 holdings 隐藏（保留占位列避免布局错位）；2) 主界面侧边导航与移动端标签的「我的持仓」图标同步隐藏，其它页签图标保留。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "导航菜单编辑器去掉全部行首字母图标",
      desc: "按用户反馈（如「资产分析」前仍有「资」）把设置页「导航菜单」编辑器每行的首字图标整格移除：删除字母头像 span，网格由 4 列调整为 3 列（拖动手柄 + 默认圆点 + 名称/URL），整行对齐不变。tsc 无错误、npm run build 通过、PM2 已重启生效。",
      kind: "fix"
    },
    {
      title: "API 文档页改为 V5 Notion 极简风格",
      desc: "按用户要求把 /api-docs 页面重塑为 V5 Notion 极简风：去掉渐变背景/模糊光斑/大阴影 hero 卡片，改为「面包屑 + 标题 + 描述 + 右侧小统计」的轻量头部；内容区细边框（浅色 #e9e9e7 / 深色 #2b2b2b）、8px 圆角、无重阴影；目录去掉虚线分隔、改为纯行；正文标题去掉装饰条、副标题用细分隔线；代码块/引用/表格 hover 全部用 Notion 中性色（#f7f6f3 / #262626），文字用 #37352f / #787774 体系。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "API 文档第 6 章子节编号 6.1-6.14",
      desc: "按用户要求给 docs/api-spec.md 第 6 章「路由清单」下的 7 个子节补编号：认证 / 资产持仓 / 行情数据 / 名人持仓 / 素材库上传 / 券商 / 设置 → 6.1-6.7；原数据模型章节 6.1-6.7 顺延为 6.8-6.14（文档内无交叉引用，目录锚点自动跟随），/api/api-docs 实时读取已生效。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "API 文档左侧目录只显示一级分类",
      desc: "按用户要求隐藏目录中的子节：左侧目录只渲染 `##` 一级章节（如 6.13 自选股分组），不再展示/展开 `###` 子节，去掉展开箭头与子节列表；子节仍保留在正文中（滚动高亮按一级章节匹配）。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "API 文档目录：6.8-6.14 全部收进「6」作子项",
      desc: "按用户要求把 6.8-6.14（券商/个股详情/公司简况/分时/K线/分组/订单）全部收进「6. 路由清单（v1）」作为子项，与 6.1-6.7 同级；目录只显示到 X.Y 一层（未编号的请求/响应示例等细节标题不进目录），展开「6」即可看到 6.1-6.14。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "API 文档补全 4 个缺失 v1 接口 + 路由表方法彩色徽标",
      desc: "核对全量 v1 路由后发现 4 个未入文档的接口：GET/POST /api/v1/financial-reports（财报列表/上传）、DELETE /api/v1/financial-reports/{id}、GET /api/v1/index-kline（指数月 K）、GET /api/v1/orders/export（订单导出 xlsx）——已补进 6. 路由清单表格并新增 6.15 财务报表 / 6.16 指数月 K / 6.17 订单导出三节；页面优化：路由表首列 HTTP 方法渲染为彩色徽标（GET 绿 / POST 蓝 / PUT 黄 / DELETE 红 / PATCH 紫，深浅色适配）。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "素材库新增「icon」类目（贵金属之后，收录全站全部图标）",
      desc: "按用户要求：素材库新增「icon」页签（位于贵金属之后，页签名即英文 icon），把全站当前使用的 25 个导航/操作/设置图标全部收录为可管理素材（settings / holdings / assets / watchlist / global / earnings / celebs / activities / users / attachments / library / site / sitemanage / stocks / profile / database / api / cron / about / trade / search / plus / refresh / close / check，SVG 存于 /uploads/asset/icon/，首次进入自动播种）；每个图标配规范中文展示名（设置/持仓/资产/自选/全球预览/盈利/名人/动态/用户/附件/素材库/网站/网站管理/股票/个人信息/数据库/接口/定时/关于/交易/搜索/新增/刷新/关闭/完成），名称与代码均可点击复制（非安全上下文自动回退）；支持行内上传替换（全局生效）、编辑名称、恢复默认，按内置规范顺序展示，浅色/深色均以灰底圆角瓦片呈现。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "素材库页签排序：加密货币 / 贵金属移到股票图标之后",
      desc: "按用户要求调整素材库顶部页签顺序：股票图标 → 加密货币 → 贵金属 → 市场图标 → 券商图标 → 分组图标 → icon，便于常用类目优先展示。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "设置-导航菜单：全部类别图标可上传（相机）+ 侧栏全局生效",
      desc: "按用户要求：设置 → 网站设置 → 导航菜单中每个类别行左侧都显示图标并内置相机浮层（我的持仓/资产分析/自选股/财报日历/名人持仓/用户/附件/素材库/日志/设置等），点击即可上传/更换；图片写入素材库 icon:<KEY>（与素材库 icon 类目同一份数据，全局生效），主侧栏与移动端标签同步显示自定义图标（无自定义时回退各类别默认图标，默认图标抽到 lib/navIcons.tsx 与侧栏共用同一套）。上传接口 icon 文件夹白名单、文件清理归类同步补齐。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "素材库标题去图标 + 删除描述文字",
      desc: "按用户要求：素材库页标题「素材库」左侧的标题图标移除，并删除下方描述「股票图标（按市值选股、分市场管理）与市场图标，唯一标识全局生效，素材保存在本地」，标题更简洁；SettingsHeader 增加 hideIcon 开关，其它设置页不受影响。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "网站形象：相机角标移入图片内 + 网站图标与首页 Logo 预览统一尺寸",
      desc: "按用户反馈修复设置 → 网站设置 → 网站形象：1) 上传相机改为图片内悬停浮层（整块预览覆盖半透明黑底 + 居中相机图标，与素材库相机交互一致），不再是贴右下角的角标；2) 首页 Logo 预览由 44×56 横条改为与网站图标一致的 44×44 方块，并补齐网站图标预览边框，两块视觉大小统一。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "素材库 icon：操作列去掉相机按钮 + 删除图标放大",
      desc: "按用户反馈：素材库 → icon 类目每行右侧「操作」列不再显示相机上传按钮（上传统一走左侧预览图悬停相机），删除/恢复默认图标由 4px 放大到 16px，按钮更清晰。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "网站形象预览悬停去灰罩（主题色描边 + 白底相机）",
      desc: "按用户反馈：网站图标/首页 Logo/网站背景预览悬停时不再盖半透明黑灰罩，改为跟随设置窗口版本主题色描一圈细边，并在图片中央浮现小白底相机图标（主题色相机），观感更干净、深浅色与四个版本主题均适配。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "网站形象预览相机按图片比例缩放",
      desc: "按用户反馈：预览图较小时（如 16×16 favicon）悬停相机圆片显得过大；改为相机圆片高度约为预览图高度的 40%、相机图标再按圆片 58% 缩放，小图小相机、大图大相机，不再盖过小图。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "网站形象预览相机深色模式适配",
      desc: "修复深色模式下相机圆片过亮、浅色主题相机看不清的问题：深色模式相机圆片由亮白改为深灰（#2b2b31 + 白描边），相机图标继续用当前版本强调色（V14 淡紫 / V1 橙 / V7 珊瑚 / V5 浅灰），深浅色与四个版本主题均清晰。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "恢复网站形象预览相机为最初角标样式",
      desc: "按用户反馈撤销悬停浮层系列改动：网站图标/首页 Logo/网站背景预览恢复为最初的右下角相机小圆标（主题色底 + 白色相机 + 卡片色描边，悬停无灰罩/无浮层），观感回到改动前。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "恢复网站形象预览相机为「太灰」提示之前的悬停浮层",
      desc: "按用户澄清：恢复为提出「鼠标划过背景颜色太灰」之前的状态——网站图标/首页 Logo/网站背景预览悬停时整块盖半透明黑罩（bg-black/35）并在图片中央显示白色相机图标，不再是角标样式。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "网站形象预览：悬停黑罩加深至 50% + 空预览灰底改透明",
      desc: "按用户要求：1) 悬停半透明黑罩由 35% 加大到 50%，呈纯黑压暗而非发灰；2) 网站图标空预览的内层灰底（bg-bg-gray）改为透明，未上传时不再显示灰色方块，直接透出白色/深色瓦片。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "网站形象预览悬停去黑罩（仅主题色相机图标）",
      desc: "按用户要求移除悬停黑罩：网站图标/首页 Logo/网站背景预览悬停时不再压黑背景，仅在图片中央浮现主题色相机图标（跟随当前版本强调色，带轻微投影保证在浅图上也可见），观感更轻。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "恢复网站形象预览 50% 黑罩 + 白色相机",
      desc: "按用户要求撤销「去黑罩」改动：网站图标/首页 Logo/网站背景预览悬停恢复为整块 50% 黑罩 + 中央白色相机图标，空预览透明底保留。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "恢复至「太灰」提示之前：35% 黑罩 + 灰占位底",
      desc: "按用户再次澄清：恢复为提出「鼠标划过背景颜色太灰」之前的状态——悬停黑罩由 50% 改回 35%，空预览占位底由透明改回 bg-bg-gray 灰底，白色相机居中不变。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "交易设置新增富途 OpenAPI 额度（已用 / 总额）",
      desc: "设置 → 交易新增「OpenAPI 额度」行：通过富途 OpenD 的 query_subscription（实时订阅额度）与 get_history_kl_quota（历史K线额度）展示 已用 / 总额 / 剩余，OpenD 在线时自动查询，也可点「查询额度」手动刷新；桥接脚本新增 quota 命令，新增 POST /api/futu/quota（管理员）。实测 OpenD 返回 实时订阅 0/100、历史K线 0/100。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "OpenAPI 额度改为仅手动查询",
      desc: "按用户要求去掉打开设置页 / 刷新网页时的自动额度查询，额度只在点击「查询额度」时拉取，避免每次刷新都打一次 OpenD。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "全球预览去重：贵金属 / 加密货币不再重复",
      desc: "排查发现重复根因：CMC「资产页」本身已含 Gold/Silver/Platinum/Palladium 等贵金属（英文名），后端又追加素材库贵金属（中文名）合并，导致每种金属出现两次。修复：合并后做硬性去重——贵金属/加密货币按 类型+代码、股票按 市场+代码 去重，素材库版本优先，再按市值排序取前 100；实测全球预览贵金属仅剩 4 条（黄金/白银/铂金/钯金）、全榜无重复。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "全球预览-资产列美化（图标左对齐 + 名称截断对齐）",
      desc: "按用户反馈美化全球预览「资产」列：由居中对齐改为左对齐，图标固定在列首，名称/代码紧随其后；名称块设置最大宽度 190px 超出省略号截断，长名称不再撑乱列宽，整列图标与文字对齐整齐。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "全球预览排名改为分享页持仓列表同款（金/银/铜大号数字）",
      desc: "按用户要求把全球预览的排名序号由圆形小徽标改为 资产分析-分享页-持仓列表 同款效果：去掉圆底，第 1/2/3 名分别用金色 #f5a623（24px 加粗）、银色 #9aa3ad（20px 加粗）、铜色 #c8864a（17px 半粗），其余灰色 #9298a1（14px 半粗），跨页时按全局排名取色。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "修复美股盘后当日盈亏重置（富途 after_change_val 字段口径错误）",
      desc: "排查「美东未到 20 点当日盈亏被重置」：富途快照的 after_change_val 实测为「盘后价-常规收盘价」（≈0），并非「盘后价-昨收」，脚本直接使用导致盘后 16:00-20:00 当日盈亏≈0。修复：盘后统一按 after_price - prev_close 计算涨跌（昨收缺失才回退官方字段）；并按「24 小时行情 + 美东 20:00 结算」口径，夜盘时段价格继续显示 overnight_price，但涨跌锁定为盘后最终价（after_price - 昨收），夜盘波动不再改动当天盈亏。实测盘后 AAPL +4.35 / NVDA -5.05 / ROBN -2.39，不再归零。",
      kind: "fix"
    },
    {
      title: "美股股价显示 3 位小数",
      desc: "按用户要求全站统一：美股（US）股价保留 3 位小数，其它市场 2 位。fmtPrice 增加 market 参数、新增 fmtNumMarket；覆盖我的持仓（现价/成本价/详情）、自选股行情、股票搜索联想、资产分析持仓表、个股详情（现价/最高/最低/今开/昨收/52周高低/均价/相关ETF）、交易订单、素材库股票列表、名人持仓持股价格、全球预览 USD 价格、当日盈亏分享图持仓列表、K线 Y 轴刻度。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "修复当日盈亏刷新闪变（-81 ↔ -936）",
      desc: "排查「美股当日盈亏刷新显示 -81，多刷几次恢复 -900+」：净资产/持仓市值一致但涨跌不同，根因是行情快照来源不一致——旧版缓存含盘后涨跌≈0 的错误快照（修复前写入），页面先读缓存显示小数值；富途桥接进程并发连接 OpenD 会互相阻塞超时，实时请求偶尔失败时旧缓存继续生效。修复：1) 富途桥接调用全局串行化（避免并发连接超时回退腾讯）；2) 行情缓存换 v2 版本号并缩短有效期为 30 分钟（作废旧错误快照，跨天不再闪旧盈亏）；3) 本次请求了但未返回的标的不再用旧缓存补值（删除后显示同步中），杜绝用过期涨跌拼出假盈亏。实测连续 5 次请求美股涨跌完全一致。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "修复素材库股票图标二次上传被重置",
      desc: "排查「素材库 NASA 上传股票图标后又被重置」：DB url 仍指向旧 PNG，但磁盘上有 18:46 上传的 SVG，DB updated_at 也停在 18:46——说明上传的文件写成功了、DB 写入也发生了，但 url 没更新。根因：upsertAsset 的 ON CONFLICT 对 source='manual' 的行保护 url/name（防自动同步覆盖），但把用户自己的再次上传也挡住了（该上传路径不带 id，路由的强制更新分支不触发）。修复：upsert 逻辑改为「自动同步仍保护 manual 行，但手动写入（source=manual）允许覆盖 url/name/board」，素材库股票上传同时显式带上 id；NASA 已恢复为用户最新上传的 SVG 图标。复现验证：第二次上传不带 id 时 url 由 /a.png 正确更新为 /b.svg。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "美股夜盘当日盈亏持续更新（不再停在旧值）",
      desc: "排查「有夜盘价格了但当日盈亏还是未更新 / 显示 -800 而券商不到 -100」：根因是夜盘时段（美东 20:00-04:00）被当作「闭市」，轮询跳过美股；且盈亏口径沿用旧一天的整天涨跌。按券商口径对齐：美东 20:00 为交易日分界，旧一天结算归档，夜盘属于新一天，当日盈亏 = 夜盘波动（overnight_price - 今日常规收盘，即富途官方 overnight_change_val），与券商一致（实测券商 -124，我们同口径 -151，差异为行情时点/持仓差异）。修复：1) marketSessions 新增 overnight 活跃时段，轮询继续、夜盘价格 24 小时实时更新；2) 夜盘涨跌改用富途 overnight_change_val/overnight_change_rate；3) 美股仅周末标记已结算；4) 行情缓存升级 v3，作废旧一天整日盈亏的旧快照，刷新不再闪现旧数值。tsc 无错误、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "个股详情页状态区分盘前/盘中/盘后/夜盘",
      desc: "按用户要求：个股详情页市场状态由「已收盘」改为按时段区分——盘前、盘中、盘后、夜盘（美东 20:00-04:00）、休市（周末）；夜盘新增为活跃时段，详情页主行情在夜盘也每 30 秒自动刷新，状态与价格同步实时。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "行情路由拆分：美股走富途，港股/A股走腾讯",
      desc: "按用户要求「美股走富途、港A用更成熟的数据源」：fetchQuotes 把美股与港股/A股拆开——美股单独走富途 OpenAPI（保证盘前/盘后/夜盘口径与 24 小时行情），港股/A股始终直接走腾讯（成熟稳定）；「仅富途」模式下美股不回退腾讯，但港A仍走腾讯。修复了此前美股+港A混批导致富途桥接超时、整体回退腾讯变成常规收盘口径（当日盈亏回到 -800 量级）的问题。实测完整 24 只持仓请求：美股全部 OVERNIGHT 口径（AAPL 0.03），港A腾讯 REGULAR，不再整体回退。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "OpenAPI 额度查询保留上一次结果",
      desc: "按用户要求：额度查询中/失败/刷新页面时保留上一次成功查询的结果——成功结果写入 localStorage（fire:futu-quota），页面加载直接恢复显示并标注「查询于 HH:mm」；查询中不闪空、失败不清空。tsc 无错误。",
      kind: "fix"
    }
  ]
};

export const V0_1_13_ENTRY: VersionEntry = {
  ...V0_1_12_ENTRY,
  version: "v0.1.13",
  date: "2026-08-20",
  summary: "资产盈亏分析页（UI）：账户资产-持仓总盈亏可点击进入，页面含盈亏总额/趋势、盈亏总结、排行榜、明细与收益日历。",
  software: V0_1_12_ENTRY.software.map((item) =>
    item.name === "Fire" ? { ...item, version: "v0.1.13" } : item
  ),
  changes: [
    {
      title: "资产盈亏分析页（UI）+ 账户资产入口",
      desc: "按用户要求（参考图 1-5）先做 UI：1) 资产分析-账户资产卡片的「持仓总盈亏」变为可点击入口，悬停高亮 + 箭头提示，点击进入 /asset-pnl-analysis；2) 页面含：市场/周期筛选（全部/美股/港股/A股 + 近6月/本年/近1年/全部 + 漏斗）、盈亏总额（USD）大数字 + 收益率 + 收益率走势/总资产趋势切换（我的 vs 标普500 图例）、全部盈亏总结（股票累计盈亏 + 盈利/亏损最大单品对比卡）、全部盈亏排行榜（盈利/亏损 Top5，名次橙红色阶 + 条形背景）、股票盈亏明细（US 蓝/HK 粉/CN 橙红市场徽标）、收益日历（月视图红盈绿亏）。当前为演示数据，逻辑/数据对接后续接入。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "资产盈亏分析页接入真实数据",
      desc: "把资产盈亏分析页的静态演示数据替换为真实数据：1) 持仓（/api/records，当前登录用户）+ 实时行情（/api/quotes）+ 汇率（/api/rates）→ 计算每只持仓的盈亏（(现价-成本)×数量，按汇率换算 USD）、盈亏总额、成本基数与收益率；2) 每只持仓日K（/api/kline/full，有界并发 + force-cache）→ 每日组合 USD 资产序列，生成收益率趋势（相对区间起点）与总资产趋势，标普500（SPY）日K作基准对比；3) 收益日历按所选月份渲染每日盈亏（资产日差）与收益率，支持前后月切换、收益/收益率切换；4) 周期筛选（本月/近1月/近6月/本年/近1年/全部）真正截取趋势与日期区间。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "资产盈亏分析接入应用壳 + 图表同款样式 + 日历数据修复",
      desc: "继续打磨：1) 资产盈亏分析改为应用壳内隐藏页签（/asset-pnl-analysis 走 [...]slug 布局，保留顶部头像一排与左侧 我的持仓/资产分析/自选股 导航，未登录跳登录）；账户资产「持仓总盈亏」点击改为客户端无感切换（selectTab pnl），返回按钮同样无感回到资产分析；2) 盈亏总额下方图表改用与资产分析同款的共用 ECharts 组件（PnlTrendChart：收益率走势=我的持仓橙线+标普500金线+面积渐变，总资产趋势=蓝线面积，横轴日期、纵轴百分比/紧凑数字、虚线网格），资产分析原图同步复用同一组件；3) 修复收益日历假数据：不同股票日K最后日期不一致时（如 AAPL 止于 08-19、港A到 08-20）组合资产计算会丢掉缺数据股票的整只市值，产生巨额假盈亏——改为每只持仓沿用最近有效收盘价；4) 市场筛选（全部/美股/港股/A股）全页生效（总额/排行/总结/趋势均按所选市场过滤），基金/新股页签暂无分类数据改为禁用态而非假页签。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    }
  ]
};

export const V0_1_14_ENTRY: VersionEntry = {
  ...V0_1_13_ENTRY,
  version: "v0.1.14",
  date: "2026-08-21",
  summary: "资产盈亏分析：收益日历市场筛选（带市场图标）、盈亏总结页签改全部/美股/港股/A股、页面整体可拖动窗口。",
  software: V0_1_13_ENTRY.software.map((item) =>
    item.name === "Fire" ? { ...item, version: "v0.1.14" } : item
  ),
  changes: [
    {
      title: "资产盈亏分析：收益日历市场筛选 + 总结页签改造 + 可拖动窗口",
      desc: "1) 收益日历新增市场筛选按钮（默认「全部」，分为 全部/美股/港股/A股，使用市场图标 MarketIcon），日历按所选市场计算每日真实盈亏（沿用最近有效收盘价），每天真实盈亏同步在日历；2) 「全部盈亏总结（USD）」下方页签由 股票/基金/新股 改为 全部/美股/港股/A股（删除基金与新股），与页面市场筛选联动；3) 资产盈亏分析页整体改为可拖动桌面窗口（与设置页同款）：抽共用 useDraggableWindow hook（标题栏拖拽、位置 localStorage 持久化、默认靠左），窗口带圆角边框阴影、内部滚动，标题栏显示「按住标题栏拖动」。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "资产盈亏分析五项修复（拖动/日历图标/明细图标/排行榜序号/首屏卡顿）",
      desc: "1) 整体拖动：改为按住窗口任意处（含标题栏）即可拖动整个窗口，按钮/输入框点击不受影响，位置仍自动保存；2) 收益日历：日期（月份）右侧新增一个日期图标按钮；3) 股票盈亏明细：每行增加股票图标（素材库图标优先，缺失回退首字母头像）；4) 全部盈亏排行榜序号改用全球预览同款样式（金 #f5a623 / 银 #9aa3ad / 铜 #c8864a / 灰 #9298a1，无底色，字号 18/15/12/12）；5) 首屏卡顿修复：持仓/行情/汇率就绪后立即渲染（总额、排行、明细立即可见），日K在后台加载，趋势图与收益日历单独显示「正在汇总…」加载态，不再等全部 K 线拉完才显示页面。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "资产盈亏分析窗口宽度对齐设置页（960px）",
      desc: "按用户要求：资产盈亏分析可拖动窗口最大宽度由 1480px 调整为与设置页一致的 960px。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "资产盈亏分析窗口可拖到视口最左边",
      desc: "修复拖动边界：此前位置按内容区相对坐标计算，最左被限制在内容区左缘（侧栏右侧）；改为按视口坐标计算（getBoundingClientRect + transform 自然位置换算），窗口可一直拖到屏幕最左/最上，右侧/底部仍防拖出屏幕，位置继续自动保存。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "资产盈亏分析拖动对齐设置页（左边界=内容区左缘）",
      desc: "按用户反馈撤销视口最左拖动：窗口左移会盖住左侧导航文字，与设置页行为不一致。恢复与设置页同款的拖动边界——transform 坐标左边界为 0（最左即内容区左缘，不越过侧栏），右/下限制防拖出屏幕，位置自动保存。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "资产盈亏分析页视觉优化",
      desc: "按截图反馈优化：1) 去掉顶部与总结卡重复的市场筛选行（市场筛选统一由「全部盈亏总结」卡片页签控制，日历另有独立市场按钮）；2) 日期范围在历史行情加载期显示「正在汇总历史行情…」而非误导性的「暂无数据」；3) 盈亏总结盈利/亏损对比卡名称允许换行（line-clamp-2），不再截断；4) 趋势图加载态改为脉冲骨架 + 提示文字；5) 标题栏拖拽提示加亮并加拖拽手柄图标（显示「按住拖动」）。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "恢复资产盈亏分析顶部市场筛选行",
      desc: "按用户要求恢复顶部「全部/美股/港股/A股」市场筛选行（与「全部盈亏总结」卡片页签联动），其余视觉优化保留。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "收益日历日期旁只保留一个图标按钮",
      desc: "按用户澄清：收益日历日期区域精简为「2026/08」+ 右侧一个日历图标按钮，移除前后月份切换箭头与 ⌄。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "恢复收益日历日期控件（前后箭头 + 月份 + 图标按钮）",
      desc: "按用户要求恢复收益日历日期区域：上个月/下个月箭头 + 月份「2026/08⌄」+ 日期图标按钮。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "收益日历市场图标下拉 + 日期选择器",
      desc: "按用户澄清：1) 收益日历日期（2026/08）右侧新增市场图标按钮（默认全部四宫格图标），点击弹出下拉可选 美股/港股/A股（带市场图标），选择后日历按所选市场计算每日盈亏；2) 日历图标按钮实现真正的「选择日期」：弹出月份选择器（年份 ‹› 切换 + 12 个月网格），选中即跳转对应月份；下拉/选择器点击不会触发窗口拖动。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "收益日历：删除日历图标按钮，日期按钮改为「选择日期」",
      desc: "按用户要求：删除日期旁独立的日历图标按钮；原「2026/08⌄」按钮改为「选择日期⌄」并负责打开月份选择器（年份 ‹› 切换 + 12 个月网格，选择器顶部显示当前月份）。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "收益日历市场/月份选择持久化 + 删除「当前」提示",
      desc: "按用户反馈：日历市场选择（全部/美股/港股/A股）与选择的月份写入 localStorage（fire:asset-pnl-cal-market / fire:asset-pnl-cal-month），刷新后保持；删除月份选择器中的「当前：2026/08」提示。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "排行榜/明细市场色块统一为分享页持仓列表同款",
      desc: "抽出共用 getMarketBadge（lib/marketBadge.ts）：US 蓝 #3b82f6 / HK 紫 #8b5cf6 / A股 按代码 SH/SZ 粉红 #e0919f（深色字），其余灰。资产盈亏分析-全部盈亏排行榜与股票盈亏明细改用该色块（30×18 圆角矩形），与 资产分析-分享页-持仓列表 完全一致；分享页同步改用同一函数。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "全部盈亏排行榜序号统一为股票盈亏明细样式",
      desc: "按用户要求：排行榜序号由全球预览金/银/铜大号数字改为与股票盈亏明细一致的灰色两位补零序号（01/02/…）。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "全部盈亏总结移到收益日历下方",
      desc: "按用户要求调整页面区块顺序：盈亏总额+趋势图（整行）→ 全部盈亏排行榜 | 股票盈亏明细 → 收益日历 → 全部盈亏总结（日历下方整行）。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "各卡片右侧统一为「选择日期」按钮",
      desc: "抽出共用 DateSelectButton（年份 ‹› 切换 + 12 个月网格），收益日历、全部盈亏排行榜、全部盈亏总结 右侧都使用该「选择日期」按钮，选中月份后日历跳转并持久化。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "恢复排行榜/总结右上角「更新至」文字",
      desc: "按用户要求：全部盈亏排行榜与全部盈亏总结右上角恢复为「更新至 xx.xx」文字，收益日历的「选择日期」保留。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "收益日历日期按钮恢复显示当前月份",
      desc: "按用户要求：收益日历右侧按钮恢复显示当前月份（如 2026/08），点击仍打开日期选择器；DateSelectButton 增加 label 参数（默认「选择日期」）。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "收益日历：年/月与收益/收益率分组隔开 + 年视图生效",
      desc: "按用户要求：收益日历右上角按钮拆成两组——「年/月」一组、「收益/收益率」一组（中间隔开）；「年」视图生效：按所选年份展示 12 个月格子，每格显示当月收益合计（或收益率，随收益/收益率切换），点击某月跳转月视图；「月」保持原有日视图。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "收益日历年视图收益加「万」单位",
      desc: "年视图每月收益 ≥1万 显示为 x.xx万（如 +1.63万），千位用 K 兜底，小额显示原值；月视图保持 K 缩写不变。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "资产盈亏分析页字体统一到资产分析体系",
      desc: "整体收敛字体层级：窗口标题 text-xl、卡片标题 text-base 加粗、盈亏总额大数字 text-2xl 加粗（收益率 text-base）、日期/更新至/图例/星期表头 text-xs、正文/排行/明细/金额 text-sm、筛选与切换按钮 text-sm、日历日期与月份格子 text-sm，与资产分析页观感统一。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "取消资产盈亏分析页可拖动",
      desc: "按用户要求移除资产盈亏分析窗口的拖动能力：删除 useDraggableWindow 使用、transform 位移、拖拽手柄提示与抓取光标，窗口保持 960px 圆角外观但固定。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "设置风格新增 V16 极简青绿 + 版本列表从小到大排序",
      desc: "设置窗口版本切换器新增 V16 极简青绿（浅色青绿白卡 / 深色墨绿青绿强调，侧栏 Logo 青绿渐变 + fire 流光同步适配），版本列表由 小→大 排序：V1 → V5 → V7 → V14 → V16。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "v16 恢复站点信息下方/网站标题上方的分隔边框",
      desc: "按用户要求：v16 风格下设置分区标题（站点信息等）与首行（网站标题等）之间恢复顶部细分隔线（1px var(--sv-border)）。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "v16 分隔线改到分区标题正下方（精调细节）",
      desc: "按用户反馈继续精调：v16 的分隔线由「首行上边框」改为「分区标题（站点信息等）正下方 1px 横线」（border-bottom + 10px 下内边距），与其它版本观感一致。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "v16 改为包裹式边框（分区整体套圆角卡片）",
      desc: "按用户澄清：v16 不是标题下一条线，而是包裹式边框——设置分区（站点信息等）整体套在 1px 边框 + 12px 圆角 + 卡片底色（var(--sv-card)）的容器里，标题与行内容同在一个盒子中。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "v16 包裹边框只包行内容，标题留在框外",
      desc: "按用户反馈修正：v16 的包裹式边框应只包住分区行内容（网站标题等），「站点信息」等分区标题保留在框外上方；边框/圆角/卡片底色套在标题后面的内容容器上。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "v16 全部分区按 mockup 框逻辑统一",
      desc: "对照 public/mockups/settings-v16.html 逐条核对：分区标题（站点信息/网站形象/交易/数据库等）改为小灰字（11px、0.04em 字距）置于框外上方；行内容统一套 1px 边框 + 10px 圆角 + 无底色盒子（overflow hidden），行间距 8px；行高 42px、内边距 7px 14px，行与行之间保留分隔线。所有设置分区一致生效。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "框逻辑应用到全部风格 + V14 改名为极简风",
      desc: "按用户要求：将分区「标题在外 + 行内容带边框圆角盒子」的框逻辑从 v16 提升为全部风格通用（V1/V5/V7/V14/V16 统一生效，V1 保留其卡片式行布局细节）；版本切换器「V14 桌面客户端」改名为「V14 极简风」。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "生成 8 款设置风格预览 HTML（清新蓝/红黑/V17/V18/TradingView/V2EX/OKX/币安）",
      desc: "按用户要求生成 8 个设置风格预览页（public/mockups/，沿用 960px 客户端窗口骨架：站点信息/网站形象/交易/数据库分区 + 侧栏 + 状态栏）：清新蓝（长桥向）、红黑经典（雪球向）、V17 石墨黑金、V18 磨砂玻璃、TradingView 风、V2EX 风、欧易 OKX 风、币安风。生成脚本 scripts/gen-style-mockups.mjs 便于后续微调重出。",
      kind: "feature"
    },
    {
      title: "8 款预览加浅色/深色切换 + 新增 Apple 液态玻璃风",
      desc: "1) 8 款风格预览每款加入标题栏「深色/浅色」切换按钮，并为每款协调设计 light/dark 两套配色（侧栏/主区/边框/输入/行悬停/开关/强调色成体系，玻璃材质与品牌色深浅版分别适配，切换带 0.25s 过渡）；2) 新增第 9 款 Apple 液态玻璃（Liquid Glass）风：macOS Tahoe 风格强毛玻璃（blur 24px + saturate 1.8）+ 高饱和渐变背景 + 顶部高光描边 + 玻璃圆角面板，浅色粉紫渐变、深色墨紫渐变，开关用 Apple 绿。生成脚本保留可随时重出。",
      kind: "feature"
    },
    {
      title: "设置风格新增 V17 石墨黑金 / V18 磨砂玻璃 / OKX / 币安 / Apple 液态玻璃",
      desc: "按用户选定把 5 款预览正式接入设置切换器（V1→V5→V7→V14→V16→V17→V18→OKX→币安→Apple）：每款含浅色/深色两套 CSS 变量（shell/bg/border/text/accent/card/input/hover）、侧栏 Logo 渐变、fire 流光、激活导航强调色；V18/Apple 为磨砂玻璃（backdrop blur + saturate），币安/V17 金色胶囊激活用深色字保证对比，V17 标题用衬线。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "设置窗口右上角新增固定按钮",
      desc: "设置窗口标题栏右上角（版本切换左侧）新增图钉式「固定」按钮：点击后窗口锁定当前位置不可拖动（图钉实心），再点解锁恢复拖动；固定状态写入 localStorage（fire:settings-window-fixed）刷新保持。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "feature"
    },
    {
      title: "删除磨砂玻璃风 + 版本下拉数字用 V7 衬线 + Apple 下拉不透明",
      desc: "1) 从版本切换器移除 V18 磨砂玻璃（含 CSS 全部清理）；2) 风格选择下拉中版本号（V1/V5/V7…）改用 V7 同款衬线字体（Georgia 系），其余文字不变；3) Apple 液态玻璃风格下，版本下拉背景改为不透明（浅色 #fff / 深色 #1c1c22），避免玻璃透底影响可读。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "v16 框逻辑全风格统一（修复 v1-grid 导致外框丢失 + 富途风网站设置排版统一）",
      desc: "根因：站点信息/交易分区外层用 .v1-grid 且 base display:contents，导致承载外框的包裹层不生成盒子（所有风格都无框），V1 还额外变成双列卡片。修复：删除 v1-grid 整套布局（base + V1 双列覆盖 + JSX 类名），所有风格统一为「标题在外 + 行内容 1px 边框圆角盒子 + 行间分隔线」，富途风网站设置不再特立独行。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "深色模式下 V1/V5/V17 分区外框边框加亮 + 删除液态玻璃风格",
      desc: "1) V1/V5/V17 深色模式下设置分区外框边框分别加亮（#3b4354 / #3a3a3a / #3a3a42），不再与深色底融为一体；2) 按用户要求整体删除 Apple 液态玻璃风格（版本项 + 全部 CSS：变量/玻璃规则/下拉不透明/Logo/fire/导航色）。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "设置分区外框边框统一（color-mix 推导，所有风格/明暗对比一致）",
      desc: "继续优化 v1/v5/v17 与 v16 的框统一：分区外框边框色改为 color-mix(in srgb, 卡片色 76%, 文字色 24%) 推导——每个风格/明暗下都保证清晰对比度且保持主题色调（如 v16 仍呈青灰、v1/v5 呈中性灰、v17 呈暖金灰），不再出现浅色近白、深色近黑的“看不见边框”；保留原深色加亮规则作为不支持 color-mix 时的兜底。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "v1/v5/v17 边框与行分隔线显色（不再依赖 color-mix）",
      desc: "按用户反馈：去掉 color-mix 推导（部分浏览器不支持会退回近白/近黑细线导致左边框与标题下方横线不可见），改为 v1/v5/v17 分别指定清晰的边框色与行分隔线色（浅色：v1 #cfd6df / v5 #d6d6d4 / v17 #cfc6ae；深色：#3b4354 / #3a3a3a / #3a3a42），保证分区框四边与「网站标题」下方横线在所有浏览器下清晰可见，与 v16 观感统一。tsc 无错误、npm run build 通过、PM2 已重启。",
      kind: "fix"
    },
    {
      title: "v1/v5/v17 侧栏左右分界线与窗口外框统一加亮（浅色/深色）",
      desc: "按用户反馈补齐 v1/v5/v17 缺失的线条：1) 侧栏与内容区之间的竖向「左右分界线」分别加亮（浅色 #cfd6df / #d6d6d4 / #cfc6ae，深色 #3b4354 / #3a3a3a / #3a3a42），不再与背景融为一体；2) 窗口最上方上边框等整窗边框统一：把 v1/v5/v17 的 --sv-border / --sv-card-border 色板整体加深到与分区外框一致，标题栏下沿、状态栏上沿、窗口外框四边、搜索框与卡片输入框边框随版本整体清晰可见。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "资产盈亏分析第一块卡片对齐参考图 + 图表改资产分析同款",
      desc: "按参考图（图1）重做资产盈亏分析-盈亏总额卡片整体布局：1) 标题行——「盈亏总额 (USD)⌵」货币下拉（USD/HKD/CNY，与资产分析页共用 fire:display-currency key，切换后大数字同步换算）+ 灰色 ⓘ 信息图标 + 方形右上箭头分享图标（原三圆节点图标替换）；2) 大数字（text-4xl）/收益率/日期改为居中排布，日期移到收益率下方；3) 收益率走势/总资产趋势 tab 改为资产分析-账户资产-收益率趋势图同款下划线样式（选中 15px 加粗 + 底部 2px 蓝色短下划线）；4) 图例改为「跑赢 ● 基准名 ▾ + 跑赢幅度」基准条（多市场下拉：标普 500/纳斯达克/道琼斯/恒生指数/上证指数/深证成指，CN 指数走 index=1，切换后按所选基准重拉日K；跑赢幅度 = 组合区间收益率 − 基准区间收益率），右侧简单加权/时间加权下拉（加权持久化）；5) 图表沿用共享 PnlTrendChart（资产分析同款：我的持仓橙线面积 + 基准对照线）。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "资产盈亏分析页整体打磨（周期联动 / 盈利图数据修复 / 取消大卡片 / 时间加权修复）",
      desc: "按反馈逐项优化：1) 盈亏总额大数字与顶部周期筛选联动（本月/近1月/近6月/本年/近1年/全部，非「全部」按区间首尾有效收盘价计算，收益率同步）；2) 盈利图数据修复——每日资产序列首日用各持仓首个有效收盘价回填（修复不同股票起始日不一致导致区间收益率算爆至 80000%），基准首值回填（修复基准线被压成直线）；3) 货币选择器带市场图标（素材库 MarketIcon，触发按钮与下拉选项均显示）；4) 删除标题旁的 ⓘ 信息图标，右上角分享改为「分享截图」按钮（html2canvas 截图卡片 → 预览弹窗 → 复制/保存，复用 /api/clipboard 剪贴板兜底，图标用资产分析-账户资产同款三圆分享图标）；5) 跑赢条改为「● 我的 ● 基准名 ▾ + 跑赢幅度」（红点对应图表我的持仓线）；6) 取消大卡片（浮动窗口）模式：改为普通页面流式布局，左对齐临界宽度 760px；7) 视觉统一：卡片/文字/下拉/胶囊接入主题色（card/text-ink/text-muted/bg-bg-gray/border-edge），涨跌色统一为 text-up/text-down，字号层级收敛（大数字 text-3xl / 收益率 text-lg 临界点），补 .dark .divide-edge 深色分隔线覆盖；8) 时间加权修复：chartPoints 的 timeIndex 按订单轨迹跟踪持仓数量与现金流链式累乘（与资产分析页口径一致），不再写死 100。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "手机端横向溢出修复（资产分析页 / 资产盈亏分析页 / 头部头像）",
      desc: "按反馈修复移动端（390px 视口）横向溢出：1) 资产分析页整体被撑到 1302px——根因是 .asset-analysis-split 单列 grid 子项默认 min-width:auto（min-content），持仓表 minWidth 1300px 把整页撑开；补 .asset-analysis-split > * { min-width: 0 }，宽表走容器内部 overflow-x 滚动（实测 scrollW 1300 / clientW 373）；2) 资产盈亏分析页也被撑到 554px，同一修复后 375px 不再溢出；3) 手机端右上角头像区域被顶部指数条（IndexTicker）溢出内容压住并超出屏幕——指数 chip 为 nowrap 且容器未裁剪，容器补 overflow-hidden（头像可见、指数条不再越过视口）；4) 头像下拉面板移动端不再超出视口——根因是外层 -translate-x-6 的 transform 让面板的 absolute/fixed 都相对变换后的容器定位、脱离视口；移除该 transform，移动端（<768px）面板改真·视口 fixed 定位（右缘距视口 12px、头部下方、保持 272px 宽度），实测 320/360/390/414px 均不溢出、桌面端居中不变。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "收益日历支持点击某天查看当日每只股票盈亏（分盈利/亏损）",
      desc: "按用户要求：收益日历的每个日期格子可点击，弹出「当日盈亏」明细弹窗：1) 按当日收盘价与前一日收盘价差额 × 数量计算每只股票当日盈亏（跟随日历市场筛选，USD）；2) 样式对齐全部盈亏排行榜（序号 + 名称 + 市场色块徽标 + 代码 + 盈亏金额）；3) 弹窗内分「盈利 / 亏损」两大页签（铺满弹窗内容宽度、两等分、居中，与股票盈亏明细按钮完全一致：py-2.5 白底阴影选中态），标题副行仅显示数量（如 4 / 1），盈利按金额降序、亏损按亏损额降序，底部显示分组合计；5) 某天全盈利或全亏损时，弹窗默认打开有数据的那一页（如全亏损日默认「亏损」）；4) 列表显示效果与全部盈亏排行榜完全一致（min-h-16 行 + 按金额比例的背景色条，盈利红底/亏损绿底，最小 20%）。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "资产盈亏分析页优化（K线内存缓存 / 死代码清理 / 加载骨架）",
      desc: "按审查优化：1) K线内存缓存（10 分钟 TTL，与资产分析页同款）：持仓与基准日K 10 分钟内不重复请求，SPA 内切页/重进秒出，失败回退上次成功缓存；2) 移除无功能（无 onClick）的漏斗筛选按钮及其图标组件；3) 移除 dayDetail 未使用的 total 字段；4) 加载骨架由双列改为单列（页面已是单列流式）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "顶部市场筛选改为日历同款图标下拉，与周期胶囊同排",
      desc: "按用户要求：顶部「全部/美股/港股/A股」文本胶囊行删除，改为收益日历同款的市场筛选（圆形图标按钮 + 下拉：全部四宫格 / 美股 US / 港股 HK / A股 CN 图标），并与周期胶囊（本月/近1月/近6月/本年/近1年/全部）合并为同一排（按钮紧跟「全部」胶囊右侧、改为漏斗筛选图标（下拉选项仍带市场图标），筛选行与下方卡片间距统一 16px（临界点）；修复市场下拉被 overflow-x-auto 滚动容器裁剪导致看似无功能的问题（按钮移出滚动容器，下拉正常弹出）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },    {
      title: "盈亏总额周期口径统一（全部改为日资产首末日差）",
      desc: "按用户确认统一口径：盈亏总额大数字不再区分「全部=浮动盈亏 / 周期=日资产首末日差」，全部周期（含「全部」）统一按日资产序列首尾有效收盘价计算区间盈亏与收益率（末资产−首资产 / 末÷首−1），数据未就绪时兜底浮动盈亏；切换周期数值连贯（demo：全部 +$4,489 / 8.33%，近1年 +$4,600 / 8.56%）。「全部盈亏总结」卡的股票累计盈亏仍为浮动盈亏口径。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },    {
      title: "修复区间盈亏虚亏（本年 -4 万 vs 真实 -7 千）",
      desc: "排查用户反馈「本年盈亏 -41089 与实际出入大」：根因是区间盈亏此前用「当前数量 × 收盘价」回填全年，今年买入的股票在年初就被按当前数量+当时价格计入，抬高年初市值导致区间虚亏。修复：区间盈亏改用订单轨迹的实际持仓市值 + 现金流修正——区间盈亏 = 末日实际市值 − 首日实际市值 − 区间净流入（买入为正/卖出为负），区间收益率改用时间加权 timeIndex（不受资金进出影响）；全部仍为浮动盈亏口径（真实累计盈亏，相对成本）。注意：仅对通过「交易」创建过订单的持仓生效（无订单历史的持仓无法还原买入日期，仍按当前数量回填）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },    {
      title: "盈亏总额改回真实累计盈亏（修复区间回填虚亏 -5 万）",
      desc: "排查用户真实数据：本年此前显示 -4.1 万～-5.8 万，但用实时行情重算相对成本的真实累计盈亏为 +2.8 万（盈利）——-5 万是「当前数量×收盘价回填年初市值」的区间口径虚亏，且用户持仓几乎无订单历史（仅 2 笔卖出），无法还原买入日期、区间盈亏不可靠。修复：盈亏总额大数字始终显示浮动盈亏口径（当前市值 − 投入成本，可靠），周期胶囊只控制图表的区间与日期范围（仍随周期变化）；另修复非交易日（周末）成交现金流被丢失的 bug（现金流游标归入下一交易日，时间加权更准）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "接入券商历史订单（长桥导出 xlsx 导入，含已清仓股票）",
      desc: "按用户提供的历史订单导出（长桥 H10891259，两份 xlsx）把真实成交接入订单系统：1) 解析 inline-string xlsx（无 sharedStrings），仅取 订单状态=已成交 的行（排除已过期/已撤销/已拒绝），按 订单号 去重（两份导出有重叠），合计 421 笔成交；2) 持仓股导入 250 笔——每只股票按时间顺序重放建仓/加减仓，位置快照（position_qty_before/after、position_cost_before/after、realized_pnl）与记录数量严格对账，基准数量 = 当前数量 − 订单净量，基准成本按 bisection 反推使重放终点成本=记录成本（记录成本为用户调整后的返佣负成本，保持不变）；3) 按用户要求保留已清仓股票：为其新建 26 条记录（qty=None、归入长桥证劵分组，名称按 ETF/主体命名规范规范化）并导入 167 笔成交（快照链自洽、最终归零）；HK 2580/2824 仅有一笔卖出（买入在导出窗口外），按窗口外基准导入、成本未知置空；SKHY 净量 +1 与零持仓矛盾、NVDA 期权订单跳过并说明；4) 删除用户手动建的 2 笔与券商重叠的旧订单（SPCH/RKLX 卖出，以券商真实日期为准）。全库 38 只有订单记录快照链逐笔自洽、最终数量对账无误；无头浏览器实测页面 盈亏总额 +$29,266 / +52.18%（浮动盈亏口径，周期无关），订单列表/收益日历/资产分析均正常。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "订单系统新增「导入」功能（券商 xlsx 历史订单回填）",
      desc: "资产分析-订单系统「导出」旁新增「导入」按钮，支持上传券商导出的 .xlsx（长桥等，格式与导出一致：21 列、inlineStr 单元格、A1=订单状态）：1) 零依赖 xlsx 读取器 lib/orderImportXlsx.ts（ZIP 中央目录解析 + inlineStr 单元格提取，与现有写入器对称，不引入新依赖）；2) 导入 API /api/v1/orders/import（16MB 上限、10 次/分钟限流）——仅导入 已成交，按 订单号 去重；代码剥交易所后缀匹配记录，无记录自动新建（qty/cost 置空、归入全部+对应市场、source=broker-import）；按成交时间重放生成位置快照链（含已实现盈亏），重放最终数量必须等于记录持仓否则整组跳过；期权与净量矛盾（导出缺单）跳过并说明；3) 幂等去重按内容指纹 (record, traded_at, side, qty, price) 而非订单号——历史订单 order_no 为随机回退号，防重复导入；4) 前端两步确认：选文件后先 dryRun 预览（识别笔数/将导入/跳过/重复 + 每股明细），确认后再真实写入并刷新订单列表；5) 导入格式规范文档 docs/broker-orders-format.md（列结构、状态语义、时区、快照对账）。实测：真实券商文件重导全部幂等识别（0 新增），构造新订单导入正确生成快照链且记录成本不变，重复导入 0 新增。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "订单系统分页（每页 9 条）+ 搜索联想",
      desc: "订单面板（资产分析/持仓详情共用）新增两项：1) 列表分页——每页 9 条，底部翻页条（上一页/下一页 + 页码窗口，当前页高亮，超出 7 页取居中窗口），显示「第 x / y 页 · 共 n 笔」；tab/市场/类型/状态/时间/排序/搜索变化自动回第一页；2) 搜索框——位于「n 笔」左侧，按 股票代码/名称/订单号 模糊匹配，输入即时联想（从当前筛选结果提取去重，最多 8 条，点击建议即应用过滤），输入即实时过滤列表（不必回车），回车应用、Esc/清除按钮复位，空结果给出提示文案。实测：417 笔 → 47 页、每页 9 行、翻页正常；输入 TSL 联想出 TSLL/TSLQ，点击 TSLL 过滤为 106 笔；输入 aapu 未回车即过滤为 34 笔。tsc 无错误、npm run build 通过。",
      kind: "feature"
    }
  ]
};

export const V0_1_15_ENTRY: VersionEntry = {
  ...V0_1_14_ENTRY,
  version: "v0.1.15",
  date: "2026-08-22",
  summary: "补全自选股相关 ETF 目录并接入 DeepSeek 视觉识别（截图导入云端 OCR 优先，Apple Vision 兜底）。",
  frontend: [
    ...V0_1_14_ENTRY.frontend,
    { name: "DeepSeek", version: "deepseek-v4-flash-vision-exp", desc: "视觉识别 · 截图云端 OCR（配 Key 时优先，Apple Vision 兜底）" }
  ],
  software: V0_1_14_ENTRY.software.map((item) =>
    item.name === "Fire" ? { ...item, version: "v0.1.15" } : item
  ),
  changes: [
    {
      title: "补全自选股相关 ETF 列表（富途搜索核对）",
      desc: "借富途 OpenD 搜索逐项核对代码与名称后补全 lib/relatedEtfs.ts：1) 新增正股条目——MU（MUU 2X做多 / MUD 1X做空）、NFLX（NFLU 2X做多 / NFLY 期权收益）、TSM（TSMX 2X做多）、SNDK（SNXX 2X做多）、UNH（UNHG 2X做多）、ECHO（ECHX 2X做多，兼容旧代码 SATG→ECHO 反向映射）、INTC（INTW 2X做多）、NIO（NIOG 2X做多）、WDC（WDCX / WDCC 2X做多）、XPEV（XPEG 2X做多）；2) 扩充已有条目——TSLA（+TSDD/TSLT/TSLR/TSYY）、AMD（+AMUU/AMDD）、MSFT（+MSFX）、GOOGL/GOOG（+GOOX）、META（+METU）、COIN（+COIW 每周收益）、RKLB（+RKLZ 2X做空）、MSTR（+MSTZ 2X做空 / MSTY 期权收益）、SMCI（+SMCZ 2X做空）；3) EchoStar 已于 2026-06-24 由 SATS 更名 ECHO，其 2X ETF 由 SATG 更名 ECHX，目录同步新代码并保留旧 SATG 记录的兼容映射；图标兜底（RELATED_ETF_MAIN_STOCK）自动覆盖全部新增 ETF，无需另配。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "补全 ETF 总市值（富途优先，缺口自动兜底）",
      desc: "个股详情页大量 ETF 总市值显示「—」：富途快照对 trust 只返回单位净值、腾讯美股 f44 为空，两家都不提供 ETF 总市值。修复：1) 保留富途/腾讯优先（普通美股走富途 total_market_val、港股/A股 ETF 走腾讯 f44）；2) 仅当市值仍缺失且为美股时，新增 lib/etfMarketCap.ts 用「份额 × 现价」（份额取 stockanalysis.com ETF 页，缺失退基金规模 aum）补市值，结果缓存 SQLite etf_market_caps 表（成功 24h / 失败 6h），不阻塞正常行情；3) 接入 v1 个股详情接口，quote.marketCap 与六币种市值同步补齐。实测 VOO/TSLL/AAPU/NASA/DRAM/RKLX/ECHX 全部有市值，AAPL 与港股 02824 回归正常。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "个股详情页相关 ETF 按市值分组排序",
      desc: "自选股点进个股详情页的 ETF 列表改为：做多一组、做空一组、收益策略一组（组内按市值从大到小，缺市值排组尾），不再按目录顺序混排；批量行情接口 /api/v1/quotes 同步补 ETF 市值（单次最多真正抓取 12 个，缓存命中为纯 SQLite 读），排序数据即时可用。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "股息记录（富途优先）+ 个股详情「股息」页签 + 订单系统股息入账",
      desc: "1) 数据层：富途 get_corporate_actions_dividends 桥接（scripts/futu_quotes.py 新增 dividends 命令）+ lib/dividends.ts 解析「1股派息0.27USD / 末期息5.3港元」等声明得到每股金额与币种，实物分派/优先发售标记为 special；SQLite dividend_cache 缓存 24h，富途不可用不缓存失败、恢复后自动可取；新增 GET /api/v1/dividends（美股/港股/A股）。2) 个股详情页：概览/ETF 旁边新增「股息」页签，展示除净日/派息日/公布日/每股金额/年度/方案原文。3) 订单系统：trade_orders.side 扩展 dividend（旧库自动重建表迁移，存量 420 笔订单无损），股息入账不改变持仓数量与成本、每股股息 × 股数记为已实现收益（realizedPnl），更正/删除重放账本同口径；我的持仓交易弹窗新增「股息」方向（默认带入当前持仓股数），订单列表与详情展示股息徽标。实测 AAPL/HK 00700/VOO/TSLL 股息均正确解析，股息订单创建/删除后持仓不变。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "股息自动入账：xlsx 导入识别股息 + 派息日自动生成订单",
      desc: "1) 券商 xlsx 导入支持股息行：方向或业务类型含「股息/红利/分红/派息」时按 dividend 入账（每股股息 × 股数记为现金收入），不再被误判为卖出，净持仓计算与重放同口径；2) 新增 lib/dividendSettlement.ts 惰性任务（getDb 触发、15 分钟节流、单实例保护）：服务器有访问时对有持仓的记录拉取富途股息，派息日已到且未生成过（订单备注 [auto:dividend:除净日] 去重）则按「除净日持仓数量 × 每股股息」自动创建 dividend 订单，卖出封顶重放不抛错、单只失败不中断。实测按历史派息自动补建 TSLL/GOOGL/AAPU/VOO/ROBN 等 15 笔股息订单，持仓数量与成本均不变，重复运行不产生重复订单。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "个股详情股息页签按年份分组",
      desc: "按用户要求：个股详情页「股息」页签改为按年份分组展示（以除净日/派息日/公布日年份从新到旧，每组显示年度与期数），并删除「数据来源：富途公司行动-分红派息（现金 / 实物 / ETF 收益分配）」提示文字；行内冗余的财年徽标一并移除，与年份分组保持一致。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "股息年份改为顶部一排切换",
      desc: "按用户要求：个股详情「股息」页签年份由纵向分组改为顶部一排年份胶囊（全部 + 各年份，从新到旧，可横向滚动），选中某年后只展示该年记录，选「全部」恢复按年份分组展示。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "修复 A 股股息与 K 线获取失败",
      desc: "1) 股息：富途 get_corporate_actions_dividends 不支持 A 股（返回空），新增东方财富分红送配接口（RPT_SHAREBONUS_DET，只取「实施分配」），每股 = 每10股派现 ÷ 10、币种 CNY，含除净日/股权登记日/公告日/方案原文，缓存 24h；A 股股息来源标记为 eastmoney，前端不再误判为「富途未连接」。2) K 线：腾讯前复权单次最多约 640 条，limit=3200（季K等长周期）直接返回 param error 导致整页失败；改为腾讯 K 线按「截止日」翻页抓取（每页 640，页序倒排拼接为升序），实测 600519/000858 可返回 2013→今 3200 条完整历史；东方财富全量历史作为最后兜底。实测贵州茅台返回 27 期实施分配股息（10派280.2423元 → 每股 28.02423 CNY）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "自选股市场/分组标签秒出（localStorage 缓存 + 后台刷新）",
      desc: "「我的行情板」的美股/港股等分组标签每次进入自选股都要等 /api/v1/watch-groups 返回才渲染（接口本身几十毫秒，但页面每次都重新请求）。修复：分组列表缓存到 localStorage（60 秒 TTL），进入页面先用缓存秒出标签、再后台拉取最新分组更新，旧配置迁移逻辑不变。实测标签在首帧即可出现。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "个股详情 URL 化繁为简：股票代码即路径，去掉 filter= 与 symbol=",
      desc: "按用户要求：自选股个股详情不再使用 ?symbol=US.GOOGL 和 ?filter=分组，改为路径式 /watchlist/US.GOOGL（股票代码就是唯一标识），分组筛选只保留在页面内（不再写入 URL）。改动：1) [...slug] 布局识别「页签路径/市场.代码」并传入 initialSymbol；2) RecordsApp 地址栏同步对详情子路径做保护，不再把 /watchlist/US.GOOGL 改写回 /watchlist；3) QuotesView 改为路径式详情（openDetail 写入 /watchlist/US.XXX、返回移除代码段、popstate 跟随），旧链接 /watchlist?symbol=&filter= 自动兼容并清理为路径式。实测直达/返回/点击/旧链接四条链路均正常。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "自定义分组图标默认取组内市值最高股票图标（券商分组除外）",
      desc: "自选股-我的行情板分组标签图标规则：1) 默认市场组（美股/港股/A股等）保持市场图标；2) 自定义分组未上传图标且非券商分组时，默认取该分组内市值最高的股票图标（行情缺失时取组内第一只有图标的股票）；3) 券商分组（如长桥/华泰，分组名命中素材库券商图标）仍走素材库券商图标；自传分组图标优先级最高。实测：核心持仓→腾讯、科技→英伟达、消费→茅台、观察中→五粮液。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "K 线副图成交额 + 下方恢复成交量 + 悬浮去掉 MA 圆点",
      desc: "个股详情页 K 线图优化：1) 副图改为上下两块——上方「成交额」（= 成交量 × 现价估算，与详情页口径一致）、下方恢复「成交量」，悬浮提示同时显示成交额与成交量（成交量在成交额下面），单位统一为中文 1亿 / 1000万 / 100万 风格（去掉 M 后缀），提示框不再有「更多」折叠；2) 鼠标划过时 MA/EMA/BOLL 指标线不再显示圆点（symbol: none），只保留主图十字线，更干净；3) 默认视图恢复全量（此前试验性「默认显示最近 8 根」导致日K仅数天、周K仅数周，已回退为默认显示全部，滚轮/拖动缩放查看）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "美股月/年K与富途对齐（周期K直连富途前复权）",
      desc: "排查谷歌-A 月K/年K与富途出入很大：根因是美股日K来源（新浪）返回未复权价——GOOGL 2022 拆股前显示 2700-3000、富途前复权约 136-150，聚合出的月/年K自然差几十倍；同期 NVDA/AAPL 等拆股股同样受影响。修复：1) 周/月/季/年K 改为美股直连富途周期K（get_history_kline + qfq 前复权），实测 GOOGL 月K（2026-01 O316.49/H341.85/L309.93/C337.56）、年K 与富途逐值一致，NVDA 2023-06 月K 从 384.89 修正为 38.41；2) 日K 主源改为 Yahoo（拆股复权）→ 新浪兜底；3) 港股/A股/日股/韩股周期K 保持腾讯 qfq 日线聚合兜底。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "K线成交额/成交量拆分为两个独立开关",
      desc: "按用户要求：副图指标由合并的「成交额/量」拆成「成交额」「成交量」两个独立按钮，默认都开启；可分别开关，面板布局随开启数量自适应（0/1/2 个副图时主图高度自动调整，成交额在上、成交量在下）。实测两个按钮独立生效。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "K线底部指标顺序与默认显示调整（成交量居首且默认开启）",
      desc: "按用户要求：K线图最下方右侧指标顺序改为「成交量」在首位、「成交额」在后；默认只显示成交量副图（成交额需手动开启），布局随开关数量自适应。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "K线新增前复权/后复权切换",
      desc: "K线工具栏新增「前复权 / 后复权」切换按钮：美股周/月/季/年K 走富途 autype=qfq/hfq，港股/A股/日股/韩股日K 走腾讯 qfq/hfq（东方财富兜底按 fqt 1/2 同步），美股日K 保持前复权（Yahoo/新浪不提供后复权，且日K窗口为近 4 个月差异极小）；请求与缓存按复权方式分键，切换即时生效、无额外网页压力。实测 GOOGL 月K 后复权（2010 O626.95 → 2026-08 C13884.40）、茅台日/月K 后复权（8966.51）均正常。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "前复权/后复权按钮深色适配 + 紧凑尺寸",
      desc: "修复前复权/后复权按钮在深色模式下背景为白色、宽度过宽的问题：新增 .dark 样式（暗色玻璃底 rgba(255,255,255,.04)、浅灰文字，悬停 .08），按钮改为紧凑尺寸（高 36px、去最小宽、11.5px 字号、圆角 9px），实测深色下宽度约 57px、不再突兀。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "截图导入接入 DeepSeek 视觉识别（云端 OCR 优先，Apple Vision 兜底）",
      desc: "按官方文档接入 DeepSeek 图像理解（deepseek-v4-flash-vision-exp）：1) 新增 lib/deepseekVision.ts——配置 DEEPSEEK_API_KEY 后截图导入优先调用 OpenAI 兼容 /chat/completions，base64 内联图片（单图上限沿用接口 8MB，低于官方 32MiB），提示词要求按「名称|代码|数量|成本|现价|涨跌幅」一行一只输出，未配置 Key / 调用失败自动返回 null；2) 导入接口改为双引擎：DeepSeek 文本行转合成视觉坐标复用现有 snapshotParser 解析（不新增解析逻辑），解析不到股票自动回退本地 Apple Vision 再试一次，响应带 provider；3) 前端预览区显示所用引擎（DeepSeek 视觉识别 / Apple Vision 本地识别），上传提示不再写死「仅本机识别不上云」（配 Key 后图片会送 DeepSeek 处理）；4) .env.example 增加 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_VISION_MODEL 说明。限流与 JPG/PNG/GIF/WEBP 校验保留。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "修复资产盈亏分析页收益率曲线假深坑（时间加权误用累计现金流）",
      desc: "资产盈亏分析页「收益率走势」曲线此前一年都平在约 -110% 的一条深坑，而盈亏总额大数字显示 +52% 的正收益，两者矛盾。根因：时间加权每日收益率算成本来用「当日现金流」，该页却把 pendingFlow 按整个序列累计后再扣减，导致前期被反复扣到接近 -100% 而后拉平。修复为与资产分析页同口径——用当前交易日现金流（非交易日成交仍归入下一交易日），去掉累计扣减；flow/actual 输出字段无下游消费，改动安全。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "收益率趋势图对齐参考图干净版（右轴 + 蓝色基准线）",
      desc: "按参考图（长桥式干净收益率图）美化共享 PnlTrendChart 与两处图例：1) 纵轴移到右侧并隐藏轴线/刻度，仅留淡虚线网格，更接近参考图；2) 基准线（标普 500 等）由黄色 #d7b900 改为干净的蓝色 #4a90d9，资产分析页与资产盈亏分析页两处图例的基准色点同步统一为蓝色，与「我的」橘色对比更清爽；3) 面积渐变、虚线网格、tooltip 保持，横轴 MM/DD 自动避让。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "登录改为长桥式弹窗（青绿配色，仅账号密码）+ 左侧配图可上传（管理员）",
      desc: "1) 应用内「登录」入口（顶栏 UserMenu / 首页登录按钮 / 访客未登录添加）由跳转改为默认弹出 LoginModal：根布局挂载全局弹窗，监听 fire:open-login 事件打开，Esc/点击遮罩关闭；/login 单独页保留供直接访问与服务端守卫使用。2) 弹窗与单独页共用 LoginForm（仅账号密码：用户名/密码/确认密码、服务协议勾选、填写完整才可点的主按钮、去注册/去登录），配色统一改为参考长桥的青绿 #1FBE9E（focus ring / 复选框 / 协议链接 / 主按钮），去掉手机验证码、扫码登录、地区选择与第三方社交。3) LoginModal 采用长桥式分栏：左侧展示站点设置项 loginSideImage（管理员在「设置-网站形象」上传/粘贴/清除，未上传用品牌渐变兜底），右侧表单区；公开设置接口同步暴露 loginSideImage 供客户端读取，新增 /uploads/login 上传类别（10MB），上传与设置接口均做管理员鉴权。tsc 无错误、npm run build 通过、登录页 200、设置写入/读取/复位链路实测定通。",
      kind: "feature"
    },
    {
      title: "登录支持用户名或邮箱 + 用户名占位文案统一",
      desc: "登录逻辑明确为「用户名或邮箱均可登录」：1) 登录页/弹窗在「登录」状态新增「用户名登录 / 邮箱登录」切换，首字段占位「请输入用户名」/「请输入邮箱」（邮箱为 email 类型）；注册仍为用户名+密码（不强制邮箱），注册模式保留「3-20 位字母、数字、下划线或中文」占位。2) 后端登录按用户名精确匹配或邮箱大小写不敏感匹配（新增 findUserByLogin，authenticateUser 复用），登录路由标识符长度上限由 20 放宽到 254（兼容邮箱）、密码上限 128 不变。3) 邮箱绑定在「设置 → 个人信息」进行：/api/auth/profile 新增邮箱格式与唯一性校验（findUserByEmail，绑定他人邮箱返回 409「该邮箱已被其他账号绑定」），绑定后即可用该邮箱登录。实测：用户名注册→用户名登录→绑定邮箱→邮箱登录（大小写不敏感）全链路通过，绑定冲突返回 409，临时用户与测试邮箱已清理。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "修复首页刷新后顶栏行情/主题/登录短暂丢失",
      desc: "首页顶栏右侧「指数行情条 + 迷你趋势、深浅色按钮、登录按钮」都依赖客户端水合后渲染：SSR 首屏 auth 为 checking、指数行情未拉到，导致刷新后顶栏空着一大块（登录/主题/行情条全消失）。修复：1) 顶栏右侧不再区分 checking/out——默认按访客渲染主题切换 + 登录按钮（登录后水合完成再替换为用户头像菜单），刷新即可见，不再有空档；2) IndexTicker 加载中由空白 42px 占位改为可见骨架条（行情图标/名称/价格/涨跌的脉冲占位），数据到达后再填充真实行情与趋势。实测 SSR 首屏已含登录按钮、主题按钮与行情骨架。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "顶部指数行情切换时市场图标即时跟随",
      desc: "首页顶部指数行情条每 5s 轮换指数，市场图标应随指数市场变化。原 MarketIcon 的 <img> 复用同一元素且带 loading=lazy，轮换时 src 已换但图片未即时刷新，视觉上「市场图标没跟上」。修复：给市场图标 <img> 加 key={市场代码} 强制按市场重挂载并立即重新加载，并移除 loading=lazy（小图标始终在首屏、需即时换图）。marketIcons 映射本身正确（CN→A股CN、US→美股US 等）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "2 倍杠杆 ETF 加 2x 徽标（青绿胶囊，x 小写）",
      desc: "参考图给 2 倍杠杆 ETF 加「2x」角标，颜色与市场色块一致：新增 lib/relatedEtfs.ts 的 isDoubleEtf(market, code, name)（遍历相关 ETF 目录命中 badge/名称的 2x/2倍/两倍，再按名称兜底覆盖港/A 股或中文名如「两倍做多闪迪」）与 components/EtfDoubleBadge.tsx（调用 lib/marketBadge.ts 的 getMarketBadge 取色：US 蓝 #3b82f6、HK 紫 #8b5cf6、A股 SH/SZ 粉红 #e0919f；白色细边与柔和投影使其与圆形象图标分离，圆角小胶囊 rounded-full、白字、文字固定小写 2x，整体与全站圆角胶囊/标签更协调）。角标按参考图叠放在**股票图标（圆形象）右上角**（absolute -top-1 -right-1），接入：自选股列表行图标（QuotesView，market/code 传记录市场）与个股详情-相关 ETF 列表图标（StockDetailView，market=US）；相关 ETF 列表原有的灰色「2X 做多/做空」徽标仍保留（用于方向说明），1x/1.5x 不加角标。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "K 线主图与成交量/成交额副图横向对齐",
      desc: "逐步定位个股详情 K 线“只开单个副图对不齐”：主图蜡烛与副图柱类目中心错位（diff 约 24px≈3 根，且只在底部显示日期标签的副图上出现）。用 ECharts convertToPixel 逐下标量测定位：ECharts 会对“显示 X 轴日期标签的 grid”自动向左内缩约 24px（即使 containLabel:false），导致只开成交量或成交额（subCount=1）、或双开后底部成交量板（grid2）首根柱相对蜡烛左移。修复：主图/成交量/成交额 grid 统一用同一组常量（containLabel:false、gridLeft=30、gridRight=64）——left=30 正好落在 ECharts 的“天然内缩位”，所有 grid 不再各自内缩，实测 subCount=1/2 在首/中/末下标 diff ≤0.44px（亚像素），日期标签保留。同时把 grid 边距/boundaryGap/containLabel 抽成共享常量，杜绝日后主副图分叉。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "K 线副图 Y 轴十字线标签处理（避免长串数字与 tooltip 不一致）",
      desc: "成交额/成交量副图 Y 轴的十字线标签默认显示原始长串数字（如 171,875,000.00）与 tooltip 的 1387.17万 不一致；尝试用 axisPointer.label.formatter 改亿/万单位无效（ECharts 对子 grid 的十字线标签不稳定，出现不显示或「—」）。最终方案：直接隐藏副图 Y 轴的十字线标签（axisPointer.label.show:false），成交量/成交额数值以 tooltip 为准，彻底消除“对不上”；保留 gridLeft=30 对齐修复。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "K 线划过主图联动高亮下方成交量/成交额柱",
      desc: "尝试做“鼠标划过主图联动高亮下方成交量/成交额柱”：给 bar 系列加 emphasis、监听 updateAxisPointer 并 dispatchAction highlight/downplay。按用户反馈已恢复（回退 emphasis 与 updateAxisPointer 监听），保留 gridLeft=30 对齐修复与副图十字线标签处理。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "K 线成交量/成交额柱去雾化（提升不透明度）",
      desc: "下方成交量/成交额柱使用 rgba(229,72,77,.48) / rgba(10,167,125,.46) 半透明填充，视觉上像蒙了一层薄膜。修复：把红/绿柱不透明度提升到 .9 / .88（接近实色，红涨绿跌方向不变），去雾化。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "修复美股当日盈亏在盘后 20:00 前被“重置”",
      desc: "我的持仓-美股当日盈亏在美东 19:21（盘后但未到 20:00 结算）被重置。根因：usExtendedQuote 的 previousClose 用 regularMarketPrice ?? previousClose 兜底，而盘后 Yahoo regularMarketPrice = 当日常规收盘，导致 change = 盘后价 − 当日常规收盘，只剩盘后波动、视觉上像当日盈亏归零。修复：盘后（wanted=AFTER）改用 meta.previousClose（昨收）作为当日基准，change = 盘后价 − 昨收 = 完整当日涨跌；盘前/常规仍用 regularMarketPrice（避免夜盘刚结束时 previousClose 滞后）。富途路径用 OpenD prev_close 字段，本身正确。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "K 线图记住上次选择的周期",
      desc: "K 线图每次进入/切换股票都默认日K。修复：把 K 线视图（周期 + 时段 + 分钟）持久化到 localStorage（fire:kline-view）——首次实现只记周期（fire:kline-range），但选「盘后」刷新后被旧周期（如5日）覆盖。现改为整体记录 { range, session, minutes }，改动即由 persist effect 自动保存，初始/进入/切换股票都整体还原：选「盘后」刷新仍是盘后、选「5日」刷新仍是5日、选「1分」刷新仍回1分。选周期（5日/日K…/季K）会把时段重置为全天；选具体时段（夜盘/盘前/盘中/盘后）进入分钟线并记录。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "修复美股周K只显示 2010-2016 旧数据",
      desc: "GOOGL 周K点开后几乎空白/全旧。根因：富途 get_history_kline 带 start=2010-01-01 且区间内根数超过 max_count 时返回“最早”的 max_count 根（OLDEST-first），美股周K 2010→今约 830 周 > max_count=320，只回 2010-2016；月/季/年K 总根数 < 320 所以正常。修复：把 start 改为按 max_count 和周期（周=7天/月=31/季=92/年=366）回推的“最近窗口”，让富途返回最近 max_count 根。实测 GOOGL 周K 现在返回 2020-07-06 → 2026-08-17。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "K 线夜盘可选 + 选「全天」不再自动切分钟",
      desc: "1) 现在有夜盘行情，时段下拉里的「夜盘 20:00-03:59」已启用（原 available:false 灰色禁用）。2) 修复“选全天右边自动选周期1分钟”：原点击时段按钮/菜单会强制 setRange(DAY) 进分钟线；改为——点击「全天」保持当前周期（日K等），只有选「夜盘/盘前/盘中/盘后」或手动在 K线周期 里点「1分/2分…」才进入分钟线。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "K 线技术指标与图表设置自动记忆",
      desc: "技术指标（MA/EMA/BOLL/MACD/KDJ/RSI/成交量/成交额）、MA 周期配置、前/后复权、图表样式、MA 均线显示/数值开关原来刷新/切换股票后都重置。新增 fire:kline-settings 持久化上述设置：readKlineSettings 校验后还原（indicators/maConfigs/adjust/style/maLinesVisible/showMAValues），持久化 effect 在改动时自动保存，进入/切换股票用保存值还原且不再把样式覆盖回第一个基础样式。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "个股详情：港股/A股时段按当地时区判定 + 价格去货币符号",
      desc: "1) 个股详情页底部时段标签对非美股写死「盘中」（currentPhase 恒为 REGULAR），导致港股/A股实际已休市仍显示「盘中」。修复：非美股改用 marketSessionState(market, now) 按当地时区判时段——pre→盘前、regular→盘中、post→盘后、overnight→夜盘、closed/lunch→休市。2) 大价格带货币符号（¥96.25 / HK$10.24），改用 fmtNumMarket（去掉符号、按市场保留小数：美股3位、其余2位）。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "个股详情报价头部对齐 Google Finance（彩色圆形箭头 + 双块布局 + 盘前/盘后）",
      desc: "按参考图（Google Finance）打磨个股详情页现价头部，并恢复「股价跟随涨跌」的精华逻辑：1) 涨跌箭头改用长桥同款实心等腰三角（viewBox 0 0 12 12，向上 M6 2.75 L9.72 9.25 L2.28 9.25 Z / 向下镜像），紧贴涨跌幅文字前并继承涨跌色；2) 股价颜色分时段——盘中左侧「今天」价格跟随涨跌色，夜盘/盘前/盘后时左侧价格为模式黑、右侧扩展股价跟随涨跌色；3) 主「今天」块以当日常规收盘为基准，右侧「盘前/盘后交易 · HH:mm」块（带月亮图标）相对常规收盘计算涨跌；4) 状态行改为「休市： 8月21日, UTC-4 16:00 (美东)」——时间不含秒、去掉币种码，按市场显示当地时区中文名（美东/香港时间/北京时间）；5) 有返回箭头时给现价行补左侧占位（pl-10），使大价格 `$` 与上方股票图标左边缘严格对齐；6) 夜盘 / 休市（美东 20 点后）也延续显示最近一次盘后交易，避免扩展时段误标「夜盘」。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "K 线「涨跌幅比较」（Google Finance 风格，独立工具栏入口）",
      desc: "个股详情页 K 线图新增「涨跌幅比较」，入口独立在 K 线工具栏（图表设置齿轮左侧），不再收进设置弹窗：1) 工具栏「比较」按钮（带折线图标，含已选数量），展开提供搜索框 + 候选列表（常见美股比较标的 AAPL/TSLA/MU/AVGO/MSFT/GOOGL/AMZN/META），带实时价格与红绿涨跌幅；2) 选中后显示图例胶囊（可删除），同时把主图与各比较标的统一为折线并按「相对视图区间首价的涨跌幅%」归一化，共用同一个 % y 轴（不再主图价格轴 + 比较 % 轴双轴混排）；3) 图表下方渲染对比表格（股票代码/价格/涨跌额/涨跌幅/昨收盘），主股票与每个比较标的各一行；4) 比较标的行情经 /api/v1/quotes 批量拉取、搜索走 /api/v1/search 防抖，切换股票自动清空。另把「今年至今」从周期按钮收进「周期 → 长周期」菜单（与季K并列）。比较逻辑全部收敛到 StockKline 组件内部。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "资产分析-持仓快捷交易窗口配色对齐参考图（顶两排黑/白 + 下方红/绿）",
      desc: "按参考图（图3买入 / 图4卖出）重排持仓快捷交易窗口的配色分层，消除「红底下半偏棕红近黑」问题：1) 方向色不再只涂表单区——整窗背景即为方向色（买入 dark:#381201 / 卖出 dark:#002e25，浅色 #fff9f5 / #f5fdf9），标题栏与名称/代码两排独立为纯黑（dark:#000）与 #171419、浅色纯白，形成「顶两排黑/白 + 下方红/绿」的分层；2) 表单输入面板统一为参考图同款 #171419 深色块（细分隔边框 dark:white/12），不再用偏蓝的 #10181b；3) 底部「0.00 USD / 预估成交后持仓成本」与方向色同底色，仅保留细分隔线，修复之前底栏落在透明背景漏出投影的问题；4) 方向色按钮（买入橙 #ff6a3d / 卖出绿 #00a985）保持；5) 字段标签深色下提亮到 white/60。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "快捷交易窗口「自定义有效期」日历向上翻开，不再溢出窗口底部",
      desc: "持仓快捷交易-时效选「自定义有效期」弹出的日历原为 `absolute top-full`（向下翻开），而「时效」位于表单最后一行，日历约 340px 高，向下超出交易窗口的 `overflow-hidden` 底缘被裁剪，日期底部 23/24/…/31 与星期错位。修复：日历改为 `bottom-full mb-1`（向上翻开），从「时效」下拉上方展开并完整落在窗口内（覆盖表单字段属正常弹层行为），底部「0.00 USD / 预估成交后持仓成本 + 买入按钮」不受遮挡。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "快捷交易窗口「买入/卖出」改为一框分段 + 所有输入框使用方向色边框（买红/卖绿）",
      desc: "按参考图：1) 方向按钮由两个分开的按钮（flex gap）改为单一圆角分段容器——买入/卖出共用一个带方向色边框的框，选中侧实色填充（买入橙 #ff6a3d / 卖出绿 #00a985）、未选中侧透明（悬停轻微高亮），容器 overflow-hidden 保证选中色块与边框贴合；2) 所有输入/下拉/方向框的边框统一为方向色——买入 #f26b41（dark #bd4218）、卖出 #2fbf93（dark #0b855f），不再用中性灰或浅桃色，做到「买入界面所有框为红色、卖出界面所有框为绿色」，与整窗方向色背景呼应。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "持仓快捷交易窗口可自由拖动（标题栏拖拽 + 位置自动保存）",
      desc: "按用户要求把持仓快捷交易弹窗改为可自由移动的桌面窗口：1) 默认居中打开（transform translate(0,0) 由居中 flex 定位），按住标题栏即可整窗拖动，四方向都能移动；2) 拖动范围做边界钳制——窗口至少保留 120px 可见横向、顶部不低于 12px、底部保留 80px，不会完全被拖出屏幕；3) 从标题栏 mousedown 到 window 的 mousemove/mouseup 全程跟随，标题栏上的关闭/最小化/最大化/置顶按钮（button）与输入控件不触发拖动；4) 位置存入 localStorage「fire:trade-window-pos」，重开按上次位置恢复；窗口 transform 会让下拉/日历的 fixed 点击遮罩随之约束在窗口内，属可接受的弹层行为，不改变下拉/日历本身的正常展开。tsc 无错误。",
      kind: "feature"
    },
    {
      title: "快捷交易窗口名称排加入股票图标并把名称/代码靠拢排版",
      desc: "按用户要求：1) 交易窗口名称/代码排（如「谷歌-A GOOGL.US」）原为名称 flex-1 在左、代码推到最右，两者被拉得很远；改为分组靠左排版——[股票图标] 名称 代码，名称与代码紧密相邻（gap-2），名称不再占满剩余宽度；2) 名称前加入股票图标，复用持仓表同一套图标来源（useAssetIcons 的 stockIcons[`MARKET:CODE`]，含 2x ETF 复用正股图标），无自定义图标时回退名称首字圆形头像（与持仓表一致）；图标与名称垂直居中、名称 text-lg 加粗、代码 text-sm 灰色。stockIcons 由 AssetAnalysisDashboard 透传给 QuickTradeDialog。tsc 无错误。",
      kind: "feature"
    },
    {
      title: "收尾 Review：交易弹窗金额/成本单位按市场原生币种 + 行情刷新不再重置表单",
      desc: "按收尾 Review 规范修复两处：1) 交易弹窗底部「成交金额 / 预估成交后持仓成本」原来硬编码 USD，港股/A股会被显示成美元；改为按 record.market 映射原生币种代码（US→USD / HK→HKD / CN→CNY / JP→JPY / KR→KRW），买卖方向均正确显示。2) 弹窗打开初始化 effect 依赖了父组件传给 livePrice 的函数引用（该引用随行情 quotes 每几秒变化），导致行情一刷新整个表单（方向/价格/数量/类型）被重置回初始值——用户正在下单时输入会瞬间被清空；改为用 livePriceRef（每次渲染同步最新引用）读取价格，初始化只依赖 [open, record?.id, initialSide, initialQty]，行情刷新不再重置表单。tsc 无错误、冒烟测试 82 项全 PASS。",
      kind: "fix"
    },
    {
      title: "订单引擎：挂单 / 市价 / 到价 & 反弹回落触发 / 有效期 / 时段 / 到期失效 / 撤单",
      desc: "补齐交易系统真正的订单引擎（此前订单类型/有效期/时段只存在于 UI，提交全被忽略）：1) trade_orders 增列 order_type / trigger_price / tif / expires_at / session / trigger_status，status 扩展到 pending/expired，旧库自动重建迁移（重建时临时关闭外键以容忍指向已删除记录的孤立订单）；2) 新订单创建走 lib/orders.placeOrder——市价单、限价单+当日有效 立即成交（沿用 executeOrder 原子更新持仓与成本），限价单+撤单前/自定义有效期、到价买入/到价卖出/反弹买入/回落卖出 记为 pending 挂单（不动持仓、快照当前持仓为 before/after）；3) 惰性结算 settlePendingOrders（GET /api/v1/orders 时触发、每用户 12s 节流）：批量拉取挂单标的现价（fetchQuotes），按类型判定触发——限价买用价格≤、限价卖用价格≥；到价买用现价≤触发价、到价卖用现价≥、反弹买用现价≥、回落卖用现价≤；命中则事务成交（applyOrder 更新持仓/成本/已实现盈亏、行转 filled/已触发），custom 超期或当日失效置为 expired/已失效，可卖不足置为超卖失效；4) 撤单 PATCH /api/v1/orders/[id] 仅 pending 可撤（置 cancelled/已撤销，二次撤单返回 400）；5) 前端交易弹窗把 订单类型/有效期/有效期日期/时段 提交给后端，挂单成功提示「已挂单，等待成交」，下单成功同时刷新持仓与订单列表。实测：限价单+当日立即成交持仓 10→15、到价买入(AAPL 触发价高于现价)挂单在 GET 时被行情触发成交且持仓更新、到价买入(触发价低于现价)保持 pending、撤单 pending→cancelled/二次撤单 400、custom 有效期写入 expires_at。tsc 无错误、npm run build 通过、冒烟测试 82 项全 PASS。",
      kind: "feature"
    },
    {
      title: "订单面板：挂单真实字段 + 待成交/已失效状态徽标 + 撤单按钮",
      desc: "订单面板原本的 委托类型/有效期/时段/触发价格/触发状态/剩余挂单/撤废单 列都是占位文案（当前系统按限价单记一笔完整成交），现接入真实数据：1) 委托类型、有效期、时段、触发价格、触发状态、剩余挂单数量、撤废单数量、成交数量按 order 实际值渲染（旧成交回退默认值、股息单显示「股息入账/—」）；2) 订单状态徽标扩展为 已成交(绿勾)/待成交(蓝时钟)/已撤销(红叉)/已失效(红叉)，状态筛选下拉新增 待成交/已失效，导出与详情文本同步；3) 待成交挂单的操作列新增「撤单」按钮，点击确认后调 PATCH 撤单并刷新；4) 排序键用真实值排序。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "账户资产三列统计对齐（当日盈亏/持仓市值/持仓总盈亏）",
      desc: "账户资产卡片「当日盈亏 / 持仓市值 / 持仓总盈亏」三列金额未对齐。实测（真实 Tailwind 渲染 getBoundingClientRect）：持仓总盈亏列金额的 top 比另两列高 8px。根因有二：1) 持仓总盈亏原为带 `py-0.5` 内边距的 <button>（另两列是 <div>），垂直各多 2px；2) 其标签用 `<span className=\"flex items-center gap-1\">`（display:flex），行高被压缩到约 12px，而另两列标签是内联 span（行高约 16px），两两叠加使其金额上移约 8px。修复：把第三列改为与另两列相同的 <div> + 内联标签 + 金额结构，点击/悬停/键盘（role=button+tabIndex+Enter/Space）挂到该 div，箭头改为 `inline-block` 内联（`ml-1`）不再影响行高；仅保留水平 `-mx-1 px-1` 让 hover 药丸略超格。实测三值 top 完全一致（105px）。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "美股 24h/夜盘行情兜底 + 数据源徽标（富途不可达时明显标注）",
      desc: "按用户要求补强美股行情容错与可感知性：1) Quote 增加 `source`（futu/tencent/yahoo），fetchQuotes 在三处赋值时标注来源——富途命中=Futu、腾讯回退=tencent、Yahoo 扩展时段覆盖=yahoo；同时 Quote.session 允许 `OVERNIGHT`（富途夜盘口径）。2) Yahoo 扩展时段兜底扩展到夜盘：`fetchUsExtendedQuote` 在 `marketSessionState(US).session === \"overnight\"` 时以 `wanted=OVERNIGHT` 请求，把美东 20:00-04:00 的分钟点归类为 OVERNIGHT，并用「今日常规收盘（regularMarketPrice）」为基准算涨跌（与富途 overnight_change_val 口径一致）；仅当 Yahoo 真返回夜盘点才覆盖，未返回则照旧回腾讯，不影响已有盘前/盘后路径。3) 新增 `components/QuoteSourceBadge.tsx`：当任意美股持仓的行情 `source===\"tencent\"`（即富途 OpenD 未连接、退回腾讯日线）时，在资产分析「账户资产」与我的持仓「账户资产」标题旁显示琥珀色「美股·腾讯兜底」小胶囊（带警示图标，hover 说明夜盘/当日盈亏可能非实时）；富途正常时隐藏。实测：OpenD 不可达时 AAPL 返回腾讯 session REGULAR、source=tencent，徽标亮起；OpenD 登录后 AAPL 返回 session OVERNIGHT、source=futu、change=overnight 波动，徽标消失。tsc 无错误、npm run build 通过、冒烟测试 82 项全 PASS。",
      kind: "fix"
    },
    {
      title: "搜索联想：富途结果缺价时自动补价（修复冒烟「搜腾讯返回腾讯控股」）",
      desc: "OpenD 在线后 /api/search 优先走富途搜索 `searchFutu`，但富途搜索偶发返回无价格结果（桥接超时/快照缺失），导致搜索联想出现「无价格」项，冒烟断言 `price>0` 失败（此改动的直接触发）。修复：`searchStocks` 在富途结果中存在缺价项时，用 `fetchQuotes` 按 symbol/market/code 补全 price/changePct（与腾讯联想路径同源），再返回。实测 /api/search?q=腾讯 现返回腾讯控股(HK) 价格 >0，冒烟 82/0。tsc 无错误、npm run build 通过。",
      kind: "fix"
    }
  ]
};

export const V0_1_16_ENTRY: VersionEntry = {
  ...V0_1_15_ENTRY,
  version: "v0.1.16",
  date: "2026-08-24",
  summary: "修复美股盘前/盘后/夜盘当日盈亏基准价错位（富途 prev_close_price 落后一个常规交易日）。",
  software: V0_1_15_ENTRY.software.map((item) =>
    item.name === "Fire" ? { ...item, version: "v0.1.16" } : item
  ),
  changes: [
    {
      title: "修复美股盘前/盘后/夜盘当日盈亏「昨收」错位（富途 prev_close_price 落后一个交易日）",
      desc: "排查「美股当日盈利还未更新」：盘前时段富途快照的 `prev_close_price` 会落后一个常规交易日（如周一盘前返回上周四收盘，AAPL 报 311.30，而真正上周五收盘是 309.35），但富途官方 `pre_change_val` 是基于真正前一常规收盘计算的（AAPL 盘前 310.35 − 309.35 = +1.05，正确）。改动：桥接脚本 `scripts/futu_quotes.py` 在扩展时段（PRE/AFTER/OVERNIGHT）命中官方涨跌字段后，用 `prevClose = price − change` 反推当日基准，保证「昨收 / 今日涨跌 / 当日盈亏」使用同一基准；缺 `change` 时同样反推，避免回退到错误的旧昨收。修复前 /api/v1/stock-detail 对 AAPL 报 price 310.4 / prevClose 311.30 / change +1.05（price−prev=−0.95，涨跌互相矛盾），修复后 price 310.4 / prevClose 309.35 / change +1.05（price−prev=+1.05 一致）。仅影响美股扩展时段行情来源，不改港股/A股、不改分享页。实测 /api/v1/quotes 全部 美股 source=futu、prevClose 与 `price − change` 严格一致；tsc 无错误、npm run build 通过、冒烟测试 82 项全 PASS。",
      kind: "fix"
    },
    {
      title: "素材库/附件管理操作按钮统一大小、配色与间距",
      desc: "按反馈放大并统一素材库、附件管理里过小的操作按钮：1) 图标素材、股票/券商/分组图标列表的操作列（编辑/预览/删除）此前尺寸与配色不一致（删除图标曾为 3px/4px、部分按钮为圆钮配 16px 图标），统一为 h-7 w-7 圆角 8px 边框按钮——编辑/预览用中性 hover（hover:bg-brand-hover hover:text-ink），删除用红色语义（hover:border-down/40 hover:bg-down/10 hover:text-down），图标统一 14px，含 disabled 态；2) 操作列与「市场」列间距由 gap-2（8px）放宽为 gap-3（12px），三个操作按钮间 gap-1（4px）放宽为 gap-1.5（6px），消除「与市场列贴太近」观感；「操作」列宽由 72px 加宽到 96px，编辑态「保存」按钮同步为 h-7 圆角框（不再布局跳动）；3) 生效文件：LibraryAttachmentsView（附件管理-素材库）、AssetLibraryView（素材库 图标/券商/分组 tab）、WatchGroupSheet（自选股分组删除按钮）、CelebsManageModal（名人持仓删除按钮×3）；删除按钮从几乎不可点的小图标变为清晰的 28×28 圆角框按钮，与相邻编辑/预览按钮完全同尺寸同风格，默认色统一 text-muted（hover 才加深）。实测：三按钮均 28×28、列间距 12px、按钮间距 6px。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "素材库图标列表显示真实文件路径（可点击复制）",
      desc: "附件管理-素材库（图标素材列表）行内新增真实路径展示：assets.url 存的是 encodeURIComponent 编码形式（如 /uploads/asset/stock/US/%E8%8B%B9%E6%9E%9CAAPL.png），此前行内仅显示名称/代码不显示路径，用户无法查看或复制素材实物文件地址。修复：1) 组件新增 realPath() 把 url decodeURIComponent 解码为可读路径（/uploads/asset/stock/US/苹果AAPL.png，与磁盘文件名一致），渲染在名称、代码下方第三行；2) 点击该行即复制真实路径（Clipboard API 优先，非安全上下文回退 execCommand 写剪贴板），复制成功 Toast「已复制真实路径」；无 url 的素材显示占位「（无本地文件）」且不可点。实测：英伟达/苹果/腾讯控股/贵州茅台等常用股票 url 均指向磁盘真实文件，解码路径与 public/uploads 一致。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "素材库国家/地区旗帜改用本地开源高清圆形 SVG（hatscripts/circle-flags）",
      desc: "素材库「国家/地区旗帜」tab 此前默认用 flagcdn.com/w80/{flagCode}.png（外部 PNG，80px，依赖外部加载）。按用户要求替换为 GitHub 开源高清 SVG 并本地保存：调研对比 lipis/flag-icons（4x3 矩形 640×480）、hampusborgos/country-flags（7410×3900 矩形）、hatscripts/circle-flags（512×512 圆形，mask 裁切）三库；用户明确要圆形旗帜，选定 hatscripts/circle-flags——每国一个 {iso2}.svg、viewBox 512×512、自带 <mask><circle r=256/></mask> 圆形裁切、MIT。（先用矩形版后按用户要求换成圆形版）；脚本批量下载 249 国圆形 SVG 本地保存到 public/uploads/asset/flag/（cn.svg 705B 与用户提供逐字节一致），缺失的 bq/bv/hm/sh/sj/um 6 国映射到真实或同源旗帜（bq→bq-bo、bv/sj→no、hm→au、sh→sh-hl、um→us，全部含 mask 圆形）；旗帜 tab 默认来源改为本地 /uploads/asset/flag/{iso2}.svg（custom?.url 上传的自定义旗帜仍优先）。实测：249 个 SVG 全部含圆 mask、Next 正常 serve（200）。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "全球经济热图国旗改用素材库国旗（本地圆形 SVG）",
      desc: "全球经济热图（/global?section=heatmap）里的国旗此前用 flagcdn.com/w40/{flagCode}.png（外部 PNG，依赖外部加载），与素材库国家/地区旗帜不一致。修复：地图悬停 tooltip 的 flagMarkup 与右侧经济看板排行的 CountryFlag 两处默认来源，从 flagcdn PNG 统一改为本地素材库圆形 SVG /uploads/asset/flag/{flagCode}.svg（hatscripts/circle-flags，512×512 圆裁切），用户上传的自定义国旗（countryFlags 自定义素材）仍优先；tooltip 圆形容器与看板 economy-ranking-flag 保持 20px 圆形显示。GlobalEconomyHeatmap 组件内 flagcdn 引用已全部清除。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "附件管理分类重构：财报文件独立成一级 tab，文件空间改名文件管理",
      desc: "把「财报文件」从素材资源内部的二级界面独立出来，作为附件管理的一级分类 tab（位于「文件管理」右侧），分类变为 文件管理 | 财报文件 | 素材资源：1) category 支持 docs/reports/library 三态；新增「财报文件」tab（文档图标）；「文件空间」改名「文件管理」；2) FinancialAttachments 从 LibraryAttachmentsView 抽出并导出为可独立复用的组件（新增 standalone 模式：独立显示搜索栏，取消原二级面包屑「图标素材/财报文件」），素材资源内部的「财报文件」二级入口按钮移除；3) 财报文件 tab 复用 /api/v1/financial-reports 数据（市场/交易所/公司/报告期分组、搜索、分页、删除）。实测三个 tab（文件管理/财报文件/素材资源）正常渲染。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "素材资源进入加速：分页缓存秒出 + 预取后续页",
      desc: "素材库（素材资源）首次进入显示「正在读取素材库」，每次挂载都重新请求分页数据。新增前端分页缓存：1) 缓存键 = fire:lib-page:{type}|{market}|{q}|{sort}|{page}，值 = {at, data}，5 分钟 TTL；2) 首次进入/切分类/翻页时，若 localStorage 有当前页缓存则立即渲染并保底显示（loading 保持 false，避免闪「正在读取」），再后台刷新覆盖；3) 请求成功后写当前页缓存，并预取第 2、3 页写入缓存（翻页秒出）；4) 无缓存时才显示 loading。实测：素材库 API 单页约 0.05s，首次进入 content 区 loading 约 0.8s 消失；二次进入/翻页由缓存秒出。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "财报文件改为类网盘文件夹导航（市场→交易所→股票→年→年报/半年报/单季报）",
      desc: "把财报文件从平铺分组改为参照主流存储网站（网盘）的文件夹导航视图：1) 面包屑逐级下钻 全部 → 市场（美股/港股/A股）→ 交易所（NASDA/纽交所等，按 exchange 细分）→ 股票 → 财年 → 报告类型，每层文件夹卡片显示该目录文件数，点击进入下一层，文件夹回到上一级（面包屑可任意回退）；2) 股票层文件夹图标默认使用素材库股票图标（useAssetIcons.stockIcons，键 市场:代码），无图标回退文件夹图标；3) 最内层（报告类型）用文件表格展示（类型/文件/大小/删除）；4) 报告类型由 fiscalPeriod + reportType 推导（FY 年报、H1/H2 半年报、Q1~Q4 单季报），新增 reportCategory/reportCategoryRank 归类函数。实测层级下钻 全部→美股→NASDAQ→Apple Inc. 正常。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "附件管理 URL 状态持久化（刷新保持分类与财报目录，URL 用稳定数字码）",
      desc: "附件管理刷新后分类与财报文件目录会重置回默认。新增 URL 状态持久化：1) 附件管理分类写入 ?category=docs|reports|library（AttachmentsView category 初始从 URL 读、切换时 history.replaceState 写回，docs 默认时移除参数）；2) 财报文件文件夹路径写入 ?view=市场/交易所/公司代码/财年/报告类型码（FinancialAttachments view 初始从 URL 解码恢复、下钻/回退时写回）。参考主流存储网站用稳定代码而非中文长名：公司用 companyCode（AAPL）、报告类型用数字码（年报=01/半年报=02/单季报=03），显示时才由 reportCategoryName 映射回中文，公司名/中文报告类型不进 URL。实测下钻至 美股→NASDAQ→Apple→2026→单季报 后 URL 为 ?category=reports&view=US/NASDAQ/AAPL/2026/03（简短），刷新后面包屑恢复「单季报/2026 财年」、视图保持。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "财报目录 URL 保留可读分隔符（去掉 %2F 编码乱码）",
      desc: "用 URLSearchParams.set 写 ?view= 时会把路径里的 \"/\" 编码成 %2F，导致地址栏出现 US%2FNASDAQ%2FAAPL... 的乱码。改为手动拼 query 字符串（encodeURIComponent 每段后按 \"/\" 拼接），浏览器地址栏显示可读的 ?view=US/NASDAQ/AAPL/2026/03；读取端仍用 URLSearchParams.get('view') 按 \"/\" 分割，兼容不变。实测 URL 无 %2F、view 还原 5 段正确。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "财报文件夹导航各层配图标（市场/交易所/股票）",
      desc: "财报文件网盘式文件夹导航每层配图标，参考主流存储网站与 TradingView 指数图标：1) 市场层（美股/港股/A股/日股/韩股）默认使用素材库市场图标（useAssetIcons marketIcons，键 market 大写），文件夹卡片显示对应市场 logo；2) 交易所层（NASDAQ/纽交所等）用 EXCHANGE_ICON_CODE 映射——交易所自家公司在素材库的图标（NASDAQ→NDAQ、NYSE→ICE、AMEX→CME），无则市场图标兜底；3) 股票层沿用素材库股票图标（stockIcons，键 市场:代码）；4) 新增标普500 市场素材与本地保存 TradingView 指数图标（标普500SPX.svg 下载自 tradingview s3-symbol-logo，美国US.svg 兜底；DJI/IXIC/NDX 等 TradingView 接口 403 限流未直连获取）。实测市场层「美股」文件夹显示美股US.svg 图标。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "文件夹图标背景深色适配（去掉深色模式下的白色底块）",
      desc: "财报文件夹卡片的图标容器此前用 bg-brand-light/60（浅色底）+ img object-cover（拉伸填充），在深色模式下图标周围露出一圈白底方块，很突兀。修复：图标容器背景改为透明（bg-transparent），图片改为 object-contain + p-1（保持旗帜/SVG 原始比例居中，不再拉伸填充）。实测深色模式下「美股」文件夹图标周围背景为深色/透明、无白色底块，整体协调。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "财报页删除说明文字 + 市场/指数文件夹支持自定义图标上传（相机）",
      desc: "1) 删除财报文件详情顶部一行「共 N 个财报文件 · 按 市场分类 / 股票名称 / 年份 / 报告类型 递进浏览」说明文字（信息冗余，层级已由面包屑体现）；2) 市场/指数层文件夹图标支持自定义上传：文件夹图标 hover 显示相机角标，点击弹文件选择，上传走 /api/upload（kind=asset folder=market）+ 更新素材库 market 图标记录（/api/assets），成功后派发 fire:assets-updated 全局刷新，市场图标全局生效（自选股/持仓/素材库同步）；图标缺失的其他层仍显示默认文件夹/日程/文档图标。实测说明文字消失、美股卡片 hover 出现相机角标与 file input。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "财报「指数/交易所」层补上自定义图标上传相机（此前仅市场层有）",
      desc: "上一步给市场/指数文件夹加了相机上传，但实测进入美股后的交易所层（NASDAQ 等）文件夹卡片没有相机——只在最外层（市场）的 folderCard 传了 uploadableKey，交易所层的调用漏传，导致 camera 角标不渲染。修复：1) folderCard 新增 onUpload 回调参数，相机角标 file input 弹文件选择后改调 onUpload；2) 新增 uploadExchangeIcon(market, exchange, file)——交易所层图标按 stockIcons[市场:EXCHANGE_ICON_CODE[e]]（如美股 US:NDAQ）取图，故把它以 type=stock（market=市场、code=NDAQ、folder=stock/{市场}）落库到素材库，成功后派发 fire:assets-updated 全局刷新，交易所图标即由素材库同名股票图标提供（与交易所自家公司图标共用一套）；3) 市场层调用同步改为传 onUpload 走 uploadMarketIcon。实测进入 美股→NASDAQ 层卡片 hover 出现相机角标；tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "财报文件夹图标统一为圆形（市场/交易所/股票）",
      desc: "财报文件夹卡片图标展示不一致：市场层招牌是圆形国旗（circle-flags 圆形 SVG）而交易所层取的是方形公司 logo（NASDAQ→NDAQ 蓝底方块），视觉上一圆一方不协调。按用户要求把文件夹图标统一为「圆形」：1) 图标容器由 rounded-[10px] 改为 rounded-full（真正圆形）；2) 图片由 object-contain + p-1 改为 object-cover（铺满圆形容器、正方形 logo 被裁成圆形，国旗因本身是圆 SVG 仍完美贴合）；3) 相机角标遮罩同步改为 rounded-full。改动后 美股（圆国旗）与 NASDAQ（圆形蓝底 N）外观一致，均为圆形。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "附件管理配色统一为蓝色（文件夹图标/头部图标与上传按钮同色）",
      desc: "附件管理-文件管理页配色不统一：文件夹图标与左上「附件管理」头部图标是橙色（琥珀色），而「上传文件」主按钮是蓝色，一橙一蓝显得割裂。按用户要求统一为蓝色：把附件主题变量 --attachment-folder（文件夹主色）与 --attachment-folder-soft（文件夹浅底）从橙色改为与 --attachment-accent 一致的蓝色——浅色 mode 橙色 #e99016→#2382f7（浅底 #fff4d8→#eaf3ff），深色 mode #f2b24d→#66aaff（浅底 rgba(242,178,77,.12)→rgba(60,145,255,.14)）。该变量驱动所有文件夹相关图标：头部附件管理图标、行/网格/详情/弹窗/树形视图的文件夹图标及文件夹浅色底，全部由橙变蓝，与上传按钮同色。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "美股 top 股票财报自动补全（SEC EDGAR 10-K/10-Q/20-F）",
      desc: "财报文件此前几乎为空（只有手动上传的 AAPL Q1）。新增脚本 scripts/backfill-sec-financial-reports.mjs 从 SEC EDGAR（美股官方）补齐持仓/自选里美股近一年财报：1) 读取 records 里美股代码（去 .AM/.N 等交易所后缀），用 SEC company_tickers_exchange.json 映射 ticker→CIK/交易所/公司名；2) 拉取 data.sec.gov 的 submissions，取最新年报（10-K，外国发行人用 20-F）+ 最近 4 个 10-Q（美股的 Q4 不单独发 10-Q 而是并入年度 10-K）；3) 按「财政年末月」推导 fiscalYear/fiscalPeriod（AAPL 2025-12-27→2026 Q1 等），保存 SEC 主文档（HTML）到 public/uploads/reports/US/{交易所}/{代码}/{财年}/{期}/，并写入 financial_report_files（file_kind=filing、source=sec）；4) 幂等（跳过已存在）、自动排除基金/ETF（ProShares、Vanguard 等，按公司名 trust/fund/proshares 等特征）。实测补齐 20 家美股共 83 份（AAPL/NVDA/MSFT/AMZN/GOOGL/META/TSLA/MU/WDC/SNDK/INTC/INTU/MSTR/NFLX/RKLB/GOOG/SPCX + NIO/XPEV/FUTU 的 20-F 年报），数据库 financial_report_files 从 1 行增至 84 行。UI：file_kind 新增 filing 类型，财报附件表格标注「SEC 文件」（FinancialAttachments）与「SEC」徽标（FinancialPanel 个股详情-财务-财报附件），点击在新窗口打开 SEC 原文。tsc 无错误、npm run build 通过。",
      kind: "feature"
    },
    {
      title: "财报公司文件夹主显示中文名、下方股票代码",
      desc: "财报文件公司层文件夹此前主显示 SEC 英文公司名（Apple Inc. / NVIDIA CORP）且下方是「代码 · N 份」。改为「主显示中文名称、下方为股票代码」：从素材库 stock 行（assets.name，如 AAPL→苹果、NVDA→英伟达、MSFT→微软、AMZN→亚马逊）建立 代码→中文名 映射（FinancialAttachments 内 stockNameMap），公司层 folderCard 主文本用中文名（无素材库映射时回退 SEC 公司名/代码），下方只显示股票代码（如 AAPL）。市场层（美股/港股）本就是中文，交易所层（NASDAQ）维持。实测公司层显示 苹果/AAPL、英伟达/NVDA 等。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "财报文件读取提速（保留 sec 冷编译 + 列表客户端缓存秒出）",
      desc: "财报文件 tab 首次进入显示「正在读取财报文件」很久。排查：dev 服务器（next dev）首次命中 /api/v1/financial-reports 与 /api/attachments 会做 Webpack 一次性冷编译（实测各 ~10s），之后降到 36ms；此外每次进财报文件 tab 组件重挂载都会重新请求并闪加载态。提速：1) 财报文件列表新增客户端缓存（key=fire:finreports:v1，5 分钟 TTL），重进 tab / 切回直接读缓存秒出首帧、loading 保持 false 不闪「正在读取」，仅无缓存时才显示加载态，后台刷新再覆盖；2) 已对 dev 服务器关键路由（financial-reports / attachments / assets）做预热，冷编译后热态 reports 约 18-26ms、页面 shell 约 365ms。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "附件管理分类 tab 图标垂直居中对齐（去掉跨行导致偏下）",
      desc: "附件管理顶部三个分类 tab（文件管理 / 财报文件 / 素材资源）的图标相对文字偏下，尤其「素材资源」最明显。排查：.attachments-space-tabs > button 是 grid（18px auto 两列），而图标被 .attachments-space-tabs > button > svg 设为 grid-row:1 / 3（跨两行网格），但这些 tab 只有「图标+文字」一行内容，跨两行会让图标垂直居中在更高的区域里而比文字偏下（移动端媒体查询里恰好是 grid-row:auto 所以不偏）。修复：基础规则改为 align-self:center，让图标与文字在同一行垂直居中（移动端原 grid-row:auto 保留不变）。实测三个 tab 图标与文字垂直对齐、不再偏下。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "素材资源筛选胶囊配色统一为中性灰（去掉橙色高亮）",
      desc: "附件管理-素材资源（LibraryAttachmentsView）的分类 tab（股票/加密货币/贵金属/市场）与股票市场筛选胶囊（全部/美股/港股/A股/日股/韩股）悬停高亮用了橙色 #FF9828（「港股」胶囊悬停呈整块橙色），与全站中性色标准不符、也未与页面其余（蓝 accent/中性白）统一。排查：橙色来自组件内联 hover:bg-[#FF9828] hover:text-black 与全局 .seg-active:hover（注释写明「中性灰白取代浅蓝」却误用橙色）；素材库分页 Pagination 也有同款橙色 hover。修复：1) LibraryAttachmentsView 分类/市场胶囊 hover 由 #FF9828 改为 hover:bg-brand-hover hover:text-ink（中性浅灰+深字，深色模式自动适配）；2) 全局 .seg-active:hover 由 #FF9828 改 bg-brand-hover text-ink（6 个组件统一，不再橙色）；3) Pagination 按钮 hover 由 #FF9828 改 hover:bg-brand-hover hover:text-ink。注：设置-主题「V1 富途橙」的 sv-accent 属可选主题色，未改动。tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "全站橙色高亮统一为中性灰（同款 #FF9828 一并清理）",
      desc: "附件管理排查发现橙色 #FF9828 高亮后，按用户要求做全站统一：首页（HomeContent）、资产库（AssetLibraryView：分类/市场筛选触发器打开态、圆形小按钮、列表项）、财报日历（EarningsCalendarView 分类/市场胶囊）、全球经济（GlobalPreviewView 双侧胶囊）、我的持仓（HoldingsView 排序/分页按钮）、自选股（QuotesView 分页按钮）共约 20 处 hover:bg-[#FF9828] hover:text-black（及打开态 bg-[#FF9828] text-black、深色 dark:hover:bg-[#FF9828]）统一改为 hover:bg-brand-hover hover:text-ink（中性浅灰+深字）、打开态 bg-brand-hover text-ink、深色 dark:hover:bg-white/10；并将 API 文档编辑器光标色 caret-color #ff9828 改中性灰 #6b7280。保留「设置→主题」V1 富途橙等可选主题预设（--sv-accent / .sv-v1 logo 与导航 / SettingsWindow 色卡）——那是刻意保留的选择型主题色，非站点高亮。实测 /、/earnings、/holdings、/watchlist、/library 均 200；tsc 无错误、npm run build 通过。",
      kind: "fix"
    },
    {
      title: "K 线「股票对比」报错 yAxis not found 修复",
      desc: "个股 K 线在「涨跌幅对比」模式报运行时错误 yAxis \"O\" not found。排查：1) markLine.data: [{ yAxis: latestPrice }] 里的 latestPrice（新增价）与 baseline 直接取 data.values 首尾值，行情接口可能返回字符串（类型标注是 number[] 但运行时是字符串），传给 yAxis 被 ECharts 当成轴名引用而抛「yAxis not found」；对比模式触发重渲染必现。修复：① baseline / latestPrice 改为 Number(...) 强转，并用 Number.isFinite 守卫——非有限数字就不画该 markLine（折线图与基准线 markLine 都加守卫）；② 对比模式下 priceSeries 不需要「最新价线」（归一化 % 轴，画最新价反而失真），直接 drop markLine（markLine: undefined）；③ compareSeries 渲染条件由 compareSeries.length>0 改为 isComparing && compareSeries.length>0，避免 compareSeries 残留时 yAxisIndex: subCount+1 越界。tsc 无错误、npm run build 通过。",
      kind: "fix"
    }
  ]
};

export const V0_1_17_ENTRY: VersionEntry = {
  ...V0_1_16_ENTRY,
  version: "v0.1.17",
  date: "2026-08-29",
  summary: "修复设置侧栏选择项目时右侧内容卡片短暂出现蓝色边框。",
  software: V0_1_16_ENTRY.software.map((item) =>
    item.name === "Fire" ? { ...item, version: "v0.1.17" } : item
  ),
  changes: [
    {
      title: "移除设置导航选中时的蓝色卡片边框",
      desc: "设置侧栏选择项目后仍保留平滑滚动与内容切换，但不再给右侧卡片添加蓝色 settings-flash 外圈动画，选中态保持中性灰视觉规范。",
      kind: "fix"
    },
    {
      title: "移除设置页主题切换与已保存状态控件",
      desc: "移除设置内容头部右侧的太阳主题切换按钮和已保存状态胶囊，并清理对应组件引用、状态回显与样式；设置修改仍会自动保存，失败时继续通过 Toast 提示。",
      kind: "fix"
    },
    {
      title: "券商分组默认展示三项并支持展开更多",
      desc: "券商分组默认按单列从上到下展示前 3 个，标题区与首条券商增加留白；浏览状态仅显示图标、中文名称和英文别名。标题旁新增铅笔按钮，点击才进入编辑状态并显示名称/别名输入框、拖动、删除、添加、取消和保存；保存继续通过服务端同步券商改名、别名、排序与删除到全站。超过 3 个时可展开更多。移除整卡按压缩放，输入框聚焦不再抖动。",
      kind: "fix"
    },
    {
      title: "设置页列表管理统一浏览与编辑状态",
      desc: "设置页列表与只读/编辑态统一：首页指数、首页导航、应用导航默认前 5 项并支持更多，列表统一紧凑宽度与单行信息布局；区块标题和内容全局保持 14px 间距。再次通过 390px 窄屏实际走查，修复移动端只能进入“网站设置/股票设置”一级分类、无法访问内部设置的功能缺口：新增当前分类二级横向导航，可直接切换站点信息、网站形象、首页指数、首页导航及股票下各子项。首页导航和应用导航在窄屏自动把路径换到下一行，避免挤压；个人信息头像区从高占位纵排压缩为 52px 横排。",
      kind: "fix"
    },
    {
      title: "设置侧栏品牌头部精修",
      desc: "按截图重新平衡设置侧栏顶部品牌区：优先展示站点已配置 Logo，无图时回退精修 F 字标；Logo 改为 32px 柔和渐变圆角块，增加细边框、内高光和轻阴影；Fire 字标加粗并收紧字距，副标题缩小压紧；品牌区底部增加细分隔线。搜索从悬浮裸图标改为常驻 28px 圆角工具按钮，带边框、背景、轻阴影和克制的上浮 hover，消除漂浮感并提升可发现性。深色实际页面已走查。",
      kind: "fix"
    },
    {
      title: "股票来源外链操作图标化",
      desc: "全局审查设置页同类入口：股票来源接口各行移除占宽的“打开链接 ↗”文字，改为左侧复制、右侧外链的双 30px 圆角图标按钮，复制后 Toast 反馈；网站形象展开面板的“打开”文字同步改为外链图标，设置侧栏 API 的裸 ↗ 改为标准外链 SVG。统一补齐主题色浅底、细描边、悬停/按压反馈、键盘焦点环和无障碍名称；保存、完成、添加、清除等需要明确语义的操作保留文字。",
      kind: "fix"
    },
    {
      title: "全站股票图标首屏加载提速",
      desc: "排查确认股票图标虽已本地化，但自选、持仓、资产分析等页面仍要等客户端挂载后请求整套 3,262 条股票素材，导致首屏图标列先空白再补出。改为服务端根据当前账户记录提取所需图标，并兼容杠杆 ETF→正股图标兜底，随应用壳首屏注入共享图标缓存；HTML 同步输出去重后的 image preload，让本地图片更早并行加载。完整素材库仍在后台刷新，不牺牲后续全市场图标。实际刷新自选页验证：首屏 6 个 preload 生效、可用图标均 complete 且 168px 图片已就绪、无首屏字母占位等待。",
      kind: "fix"
    },
    {
      title: "设置侧栏品牌花标打磨（连续点击才转圈 + 居中 + 搜索移入标题栏）",
      desc: "1) 品牌花标改为「点击一次转一圈、连续点击连续转」：每次点击目标角度 +360°，单次点击平滑转满一整圈后停稳，连续点击则目标不断前移、持续顺滑地转；改用临界阻尼弹簧在角度目标上做物理积分（requestAnimationFrame），并设定角速度上限，消除原先速度突跳/急停导致的卡顿，旋转起步缓、中间快、收尾柔。花标外轮廓由原来的细长六瓣「星芒」打磨成参考图那种圆凸瓣、浅凹口的云朵/花瓣式外形（保留花瓣式轮廓），内容恢复为 Fire 趋势折线 + 箭头，并恢复其「先描绘自己、箭头在画到末端时浮现」的播放动画（默认静止，仅在鼠标悬停或连续点击转动中播放）；去掉多余的填充/轨道环等装饰，并去掉花标外层的圆角方框、改为无框呈现（旋转时花瓣外浮出柔和光晕）；2) 移除侧栏品牌区的「Fire 投资记实」文案，花瓣在品牌区水平居中；3) 搜索按钮从侧栏移入设置窗口标题栏工具组（置顶图标左侧），点击仍唤起 ⌘K 命令搜索（改为窗口事件触发），命令面板固定于设置窗口右上角、紧贴搜索按钮下方浮出。tsc 无错误。",
      kind: "feature"
    },
    {
      title: "设置窗口宽度以 800px 为基础优化",
      desc: "设置页桌面窗口最大宽度定为 800px（.sv-win-root、SettingsWindow 的 max-w 与静态 mockup 同步），并保留单行排版、输入框弹性伸缩、细滚动条等基础优化：股票来源行控制区约 316px，常见链接可完整显示；股票来源链接在非编辑态改为带「…」省略号截断的文本 span（悬停 title 显示完整 URL），编辑时才显示输入框，避免输入框内部硬切显得难看。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "修复切换设置左选项时整个页面往上滚",
      desc: "点击设置左侧导航 / ⌘K 搜索结果时，jumpTo 原先用 el.scrollIntoView({block:'start'}) 把目标锚点贴到视口顶部，导致整个页面(document)一起上滚、设置窗口整体上移。改为只在设置内容滚动区(.sw-content-scroll)内滚动：用 getBoundingClientRect 差量计算目标 scrollTop 后 container.scrollTo({behavior:'smooth'})，不再影响页面整体位置。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "设置行改单行排版：输入框弹性伸缩、取消横向滚动/换行",
      desc: "设置里「股票来源接口」的复制/新窗口图标、「交易·富途」的查询额度文本此前会因 786px 下空间不足而换行或出现难看横向滚动条。改为让 .sw-row .ctrl 保持单行(flex-wrap:nowrap、取消 overflow-x 滚动条)、输入框改为 flex:1 1 auto(最小 120px)弹性伸缩以贴合可用宽度(URL 在输入框内部滚动)，富途额度文本允许 min-w-0+overflow 收缩、行情源胶囊不换行；这样单行、无滚动条、无换行，更干净。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "侧栏花标放大 + 设置内容区滚动条改细",
      desc: "1) 侧栏品牌花标按钮由 40px 放大到 46px、内部 SVG 由 34px 放大到 40px，云朵花瓣更大、与侧栏更协调；2) 设置内容滚动区(.sw-content-scroll)补一条 6px 细圆角滚动条(webkit + scrollbar-width:thin，用主题色半透明)，替代浏览器默认粗滚动条，与全站其它细滚动条一致。tsc 无错误。",
      kind: "feature"
    },
    {
      title: "设置页输入默认态统一为只读（站点信息/交易富途补编辑铅笔）",
      desc: "按已建立的“默认只读、点编辑铅笔才可编辑”规范，对设置页做全局排查并补齐常显输入框：站点信息(网站标题/域名/页脚)、交易·富途(OpenD 主机/端口)、网站形象(图标/Logo/背景/登录图的粘贴链接输入框及上传/清除按钮)、数据库(数据库类型卡 + PostgreSQL 连接输入框 + 测试/保存)原先默认直接显示带边框输入框；现为这四块增加“编辑铅笔 + 完成”切换，非编辑态输入框改为 readOnly 并去掉边框/背景/阴影、上传/清除/类型切换/保存禁用(纯展示，仅 UI，不改数据)。券商分组、首页指数/首页导航/应用导航、来源接口、个人信息已有编辑态，无需改动。tsc 无错误。",
      kind: "feature"
    },
    {
      title: "个人信息「复制 UID」改图标 + 设置页内容溢出排查",
      desc: "「个人信息」昵称/登录邮箱/登录名三行统一结构：值区改为 flex:1 容器、内容左对齐，各加一个 30px 圆角复制图标在最右(昵称/邮箱/UID 分别复制，disabled 降透明度)——复制图标按钮不再超宽、三行值起点与复制按钮位置一致对齐；同时给 .settings-code-value 去掉边框/背景、左对齐纯文本并加 flex:1 1 auto 填充(带 max-width:100% + ellipsis/nowrap 防长值撑宽)，使 admin、/api/v1 等只读代码值与其它只读展示一致。tsc 无错误。",
      kind: "fix"
    },
    {
      title: "新增「网站设置导出/导入」全量无损迁移",
      desc: "个人信息新增「网站设置导出 / 导入」卡片：导出生成 fire-site-backup-*.json（含 format/version/appVersion/exportedAt 与 manifest 计数），data 覆盖站点设置(全部 key-value)、个人偏好、持仓记录、成交订单、操作日志、自选分组、名人持仓与当前用户昵称——纯数据；图标/图片为应用默认、上线自带，不打包。导入校验 format/version，导入前自动做一次数据库快照备份，随后在单事务内按 id upsert(存在更新、不存在插入) 还原 records→trade_orders→activities→watchGroups→userSettings→celebs→site_settings，所有 user_id 重映射为当前导入用户，并恢复昵称，做到不覆盖不丢失。新增 GET/POST /api/v1/data/export|import(仅管理员) 及 docs/api-spec 6.18。tsc 无错误。",
      kind: "feature"
    },
    {
      title: "网站数据导出/导入打磨（manifest 说明 + 纯数据 + 两步导入）",
      desc: "导出文件 manifest 增加 excluded 说明字段(图标/图片为应用默认上线自带；数据库连接串等环境专属配置不迁移)；导出排除 dbType/pgHost/pgPort/pgDatabase/pgUser/pgPassword 等环境专属设置键，避免上线时把开发库连接带到线上；导入改为两步——先 POST /api/v1/data/import?preview=1 做服务端校验+试算条数(不写入)，前端预览条数并确认后再正式导入(单事务 upsert，恢复昵称)。tsc 无错误。",
      kind: "feature"
    },
    {
      title: "网站数据导出/导入开放给普通用户 + 按角色作用域防注入 + 新增注销账号",
      desc: "1) 网站数据导出/导入不再仅管理员：所有登录用户可用，导出/导入按当前用户作用域——普通用户只迁自己的 userSettings/records/tradeOrders/activities/watchGroups/昵称；管理员额外含 siteSettings 与 celebs(名人持仓)。2) 防导入注入：普通用户即使备份里带了 siteSettings/celebs 也会在导入时被忽略，仅管理员可写入站点级数据；user_id 一律重映射为当前用户，不会越权。3) 新增 POST /api/v1/auth/delete-account 注销当前账号：级联删除该用户 sessions/records/trade_orders/activities/watch_groups/user_settings 并尽量删除头像文件；保护最后一个管理员(不可删除)。个人信息「数据」区新增红色「注销账号」入口，并加**输入登录名确认**的二次验证(需准确输入用户名才能确认注销，防手误)。tsc 无错误。",
      kind: "feature"
    },
    {
      title: "设置个人信息页视觉层级精修",
      desc: "个人信息头像区升级为独立身份卡：加入主题渐变底、圆角边框、头像白色描边与柔和阴影，并补充昵称、@用户名及管理员/成员徽标；密码表单改为独立浅底圆角容器；网站备份与持仓导出归入统一的数据操作面板；清空数据与注销账号从普通数据项中拆出，归入红色弱提示的危险操作区，避免与安全操作混排。窄屏下身份卡自动切换横向布局，保持信息紧凑清晰。",
      kind: "feature"
    },
    {
      title: "网站数据导入导出与个人信息页全量安全加固",
      desc: "修复安全审计发现的全部问题：1) 导入固定逐表字段白名单，彻底移除不可信列名拼 SQL；2) 导入 ID 与当前用户已有数据冲突时才更新，新增或跨用户冲突全部生成新 ID，并重映射持仓→订单、分组引用，阻断跨用户数据归属夺取；3) 严格校验格式版本、字段、JSON、长度、数值、引用归属、站点设置键白名单，限制 10MB、各表条数、总 7.5 万行及调用频率；4) 导入前备份失败即停止，预览与正式导入执行同一归属检查，历史孤立订单不再进入备份；5) 导出/个人资料响应 no-store，Web 登录不再向 JS 返回 token，移动端 token 保留在独立 v1 登录；6) 清空持仓和注销账号均由服务端验证当前密码并限流，清空使用事务同步处理订单；修改邮箱也要求当前密码；7) 上传增加用户/全局限流；8) 新增 security_audit 持久安全审计日志，记录导入、导出、上传、改密、清空、注销与拒绝事件。恶意字段、越权订单、过新版本、无密码清空/注销均实测拒绝；跨用户同 ID 正式导入实测原归属不变且副本自动换 ID，测试数据已清理；有效导出→预览闭环通过；npm audit 0 漏洞、tsc 与生产构建通过。",
      kind: "security"
    },
    {
      title: "Fire 花标外轮廓精确改为圆润云朵形",
      desc: "按 ChatGPT 新对话动画参考重新构造设置侧栏 Fire 花标：彻底移除连续小波浪，外轮廓仅保留 7 个清晰的大体块，采用非对称云朵结构、宽缓连接、饱满底瓣和更大的内部留白；中心 Fire 趋势箭头同步放大、简化折点并加粗圆角描边，解决原符号过小过碎的问题。点击一次一圈、连续点击连续旋转的弹簧动画保持不变。",
      kind: "fix"
    },
    {
      title: "Fire 花标恢复默认设计",
      desc: "按要求撤销本轮 ChatGPT 云朵轮廓与中心符号比例调整，恢复项目原有默认外轮廓、中心趋势箭头、描边粗细和缩放比例；点击旋转交互继续保留。",
      kind: "fix"
    },
    {
      title: "设置页编辑入口收敛为页面级统一按钮",
      desc: "解决设置卡片标题旁铅笔过多造成的视觉噪声：隐藏站点信息、网站形象、首页指数/导航、应用导航、券商分组、股票来源、富途连接、个人信息和数据库各自重复的编辑铅笔，在设置内容标题栏仅保留一个带文字的“编辑”按钮；按钮根据当前侧栏栏目准确开启对应编辑态，首页导航会同时开放首页与应用导航。标题副文案同步显示“只读浏览/正在编辑”，复杂列表原有保存、取消、拖动、删除与添加逻辑保持不变；站点注册开关在只读态同步禁用，避免展示态仍可误改。",
      kind: "feature"
    },
    {
      title: "修复设置标题栏工具与编辑按钮重叠",
      desc: "修复搜索、置顶、风格切换三个悬浮方块与页面级编辑按钮占用同一坐标、遮住栏目标题的问题：搜索、编辑、置顶与风格切换全部保留原有 32px 图标尺寸；编辑铅笔正式移入窗口标题栏组件并放在搜索右侧，顺序为“搜索 → 编辑 → 置顶 → 风格切换”。不再依赖内容页绝对定位，因此加载中、切换栏目和内容重渲染时按钮始终连续存在，不会留下空洞。页面标题为完整工具组预留固定安全区。",
      kind: "fix"
    },
    {
      title: "个人信息复制按钮与下方操作列右对齐",
      desc: "修复昵称、登录邮箱、用户名三行复制图标使用字段网格右边线，而数据备份与危险操作按钮使用卡片内缩右边线导致的错位；桌面端为个人资料字段列补齐与下方操作面板一致的 12px 右内边距，使复制、导出、导入、清空和注销按钮落在同一条垂直基线上。移动端恢复满宽，避免重复内缩。",
      kind: "fix"
    },
    {
      title: "个人信息值区收紧并让复制按钮跟随文字",
      desc: "按文字边界重排个人资料三行：撤销将复制按钮吸附卡片右侧的操作列方案，昵称、邮箱、用户名的复制图标改为紧跟各自文字尾部；字段标签列由 180px 收紧到 142px 临界宽度，让昵称、邮箱和用户名整体左移并消除中间大块空白。长邮箱仍保留省略号与最大宽度保护，移动端标签列进一步收紧为 112px。",
      kind: "fix"
    },
    {
      title: "修复资产分析收益率趋势的虚假盈亏",
      desc: "排查确认“简单加权”此前使用当前持仓数量乘历史收盘价，等同假设今天全部仓位年初已持有，并把期末市值减期初市值误标为累计盈亏；今年大量买卖时会制造截图中的 -30.25% / -$34,257 虚亏。现按成交订单逐日还原 positionQtyAfter，简单加权改为（账本累计盈亏 ÷ 实际投入资本）指数，顶部累计盈亏改用 buildPortfolioLedger 的已实现+未实现经济盈亏；时间加权将周末/节假日成交现金流通过二分查找归入下一有效行情日，并对首次可确认的旧仓按当日市值视为外部转入，避免仓位突然出现被算成收益。无订单持仓从 updatedAt 首个可确认日才纳入，不再回填年初，页面显示订单覆盖数提示；订单请求上限由 500 提至 5000，趋势缓存升级 v3 并纳入成本和更新时间签名，避免旧错误缓存复用。",
      kind: "fix"
    },
    {
      title: "修复本月盈亏误显示全历史累计金额",
      desc: "修复收益率趋势切换到“本月”后顶部仍显示约 3.3 万美元全历史累计盈亏的问题：金额现与周期按钮使用同一趋势账本，本月/近 1 月/近 6 月/本年/近 1 年/自定义区间分别显示对应区间盈亏，只有“全部”显示累计盈亏；计算以区间开始前最后一个有效交易日为基准，包含首个交易日变化。资料不完整的旧仓在首次可确认日将盈亏基线归零，避免历史浮盈一次性落入当月；趋势缓存升级 v4。",
      kind: "fix"
    },
    {
      title: "收益趋势跑赢跑输文案跟随盈亏",
      desc: "收益率趋势图的组合图例不再固定显示“跑赢”：当前所选周期金额盈利时显示“跑赢”，亏损或持平时显示“跑输”；切换本月、本年、全部或自定义区间后即时同步。标普 500 名称及右侧相对收益差值保持原有口径。",
      kind: "fix"
    },
    {
      title: "新增多币种资金系统并纳入账户净资产",
      desc: "资产分析新增全站统一七币种资金系统，数据库、API、备份导入及账户现金汇总同步扩展，旧账本无损迁移；主体采用三列响应式资金流转图。“新增资金记录”持续精修：方向使用分段状态，类型使用可视化卡片，日期使用站内自定义日历。金额输入采用“透明原生输入层 + 逐字符彩色展示层”：每个已键入数字按红、橙、黄、紫、蓝、青、绿顺序独立着色，不再把整串文字裁成一张渐变；千分位逗号保持中性灰。末尾自绘闪烁彩色光标使用下一位数字即将采用的颜色并带轻微光晕，真正体现输入前后颜色连续性；点击金额区始终把输入位置保持在末尾，避免透明输入层光标与展示层错位。底层仍剔除一切非数字字符、归一前导零并限制 1 万亿元，千分位只用于显示，提交为纯数字。资金记录随网站备份导入导出；历史订单每页 5 笔，当日订单每页 9 笔；新增规范 v1 资金 API。",
      kind: "feature"
    },
    {
      title: "修复深色模式金额彩虹数字被原生文字遮挡",
      desc: "排查确认深色模式的全局 input 文字颜色规则覆盖了资金金额透明捕获层，导致原生浅色数字位于逐字符彩虹层上方。现对 fund-amount-input 的 color、-webkit-text-fill-color、caret-color 与 selection 使用高优先级透明覆盖，保留透明输入层的键盘能力，同时让后方逐位彩色数字与下一位彩色光标真实显示。",
      kind: "fix"
    }
  ]
};

export const V0_1_18_ENTRY: VersionEntry = {
  ...V0_1_17_ENTRY,
  version: "v0.1.18",
  date: "2026-08-30",
  summary: "撤回资金记录以外的全局彩虹输入。",
  software: V0_1_17_ENTRY.software.map((item) => item.name === "Fire" ? { ...item, version: "v0.1.18" } : item),
  changes: [{
    title: "撤回资金记录以外的全局彩虹输入",
    desc: "按要求取消持仓、行情、快捷交易、FIRE、导入、名人持仓、财报、K 线及设置等页面的全局彩虹输入，恢复各页面原有数字控件与交互；仅保留新增资金记录中的专用彩虹输入效果。",
    kind: "fix"
  }, {
    title: "股票添加搜索框支持逐字符彩虹输入",
    desc: "在“我的持仓-添加股票”和“自选股-股票添加”两个搜索框启用实时逐字符彩虹显示；中文、英文、数字和原有搜索键盘交互均可正常输入，其他文本输入框不受影响。",
    kind: "feature"
  }, {
    title: "修复首屏应用壳长时间停留在加载态",
    desc: "排查发现默认“我的持仓”和“自选股”虽已有服务端注入的持仓与设置数据，却仍使用 ssr:false 动态加载，首屏只能显示应用壳和“加载中…”。现改为服务端首帧渲染这两个高频页面，其他重型页面继续按需加载，减少白屏式等待。",
    kind: "fix"
  }, {
    title: "资产标签改用中性灰并优化搜索提示色",
    desc: "我的持仓页的显示货币、资产指标标签、各市场盈利说明与表头改为中性灰，减少冷色灰带来的视觉偏移；股票添加搜索框占位提示单独改为冷灰蓝，已输入的加粗彩虹文字和盈亏红绿语义保持不变。",
    kind: "fix"
  }, {
    title: "自选股截图导入改为轻量模式并支持批量分组",
    desc: "自选股页面的截图导入入口改名为“截图导入自选股”，预览表隐藏数量、现价、成本等持仓字段，仅保留名称、代码、市场与状态；确认导入前可选择自定义分组，将本次识别结果一次性归入该分组。持仓页面继续保留完整持仓字段，服务端校验分组归属后再写入。",
    kind: "feature"
  }, {
    title: "自选股行情板布局与批量操作继续精修",
    desc: "自选股行情表的编辑、移动、删除操作统一为紧凑按钮组，默认只读时隐藏行内操作，编辑模式下稳定显示；操作列收紧并在横向滚动时贴右可见。移动下拉改为轻量自定义箭头与焦点反馈，股票、现价、涨跌幅、走势图与行情时间增加稳定最小宽度，中等窗口不再把名称压成短省略号。标题区新增行情数量、状态圆点、最后刷新时间和手动刷新，刷新间隔控件同步收紧。勾选股票后，批量移动与删除改为独立工具条，不再挤压刷新区；选中行增加轻量高亮，分页信息改为当前条目范围。",
    kind: "fix"
  }, {
    title: "全站迷你走势图接口优化：gzip + 抽样 + 缓存",
    desc: "/api/charts 迷你走势响应改为 gzip 压缩，并对批量走势做固定点数抽样（约 940 点压到 60 点），显著减小单次请求体积；同时为腾讯分钟数据增加 30 秒内存缓存，减少重复外部请求。抽样改为逐请求 opt-in：首页（自选股 + 我的持仓 近5日走势）与自选股行情板声明 sample 才抽 60 点；个股详情 K线 /api/kline 与该分时不声明，仍保留全量分时点。",
    kind: "feature"
  }, {
    title: "首个注册用户自动成为管理员",
    desc: "注册逻辑改为：首个非测试注册账号自动成为管理员（role=admin），无需预先在 .env 配置管理员。同时保留 INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD 兜底：生产环境仅在两者均合法（用户名 3-20 位、密码 8-128 位含字母+数字）时才用它建管理员；未提供或不合规时不再抛出“必须配置管理员”错误，而是交由首个注册账号接管。",
    kind: "feature"
  }, {
    title: "修复局域网 HTTP 登录后无限跳回登录页",
    desc: "生产环境 session cookie 固定带 Secure 标志，局域网 http://IP:port 明文访问时浏览器不保存/不发送该 cookie，导致登录成功后会话丢失、被反复重定向回登录页。现改为按请求是否真正走 HTTPS（x-forwarded-proto 或 url 协议）动态决定是否带 Secure，HTTP 访问可正常登录并保持会话。",
    kind: "fix"
  }, {
    title: "修复 PWA manifest 构建期预渲染空库报错",
    desc: "app/manifest.ts 在 next build 时会被静态预渲染并读取站点设置（触发建库 seed），空库 + 生产模式下因缺少 INITIAL_ADMIN_* 导致构建失败。已将 manifest 路由标记为运行时动态（force-dynamic），构建不再预渲染碰库，改为请求时读取真实站点标题。",
    kind: "fix"
  }, {
    title: "修复新用户素材库图标缺失时显示占位",
    desc: "全新用户（素材库为空 / 默认图标文件未随部署打包）时，导航、货币、设置菜单等图标因引用不存在的 /uploads/asset/... 而显示「?」破图。新增 SafeAssetImage 安全加载：图片加载失败自动回退内置矢量默认图标（NAV_ICONS / 地球），不再出现「?」；同时基础素材库图标（icon / flag / market 等）随镜像打包并在首次启动复制到挂载目录，新用户开箱即用完整图标。",
    kind: "fix"
  }, {
    title: "线上名人持仓默认使用定制头像",
    desc: "修复 Docker 部署中 data/celebs-avatars.json 不进镜像，导致线上新库虽有定制头像文件，却因缺少映射而回退原始照片。六位内置名人现直接使用定制头像作为默认值，并增加一次性数据库迁移，仅替换明确的旧默认路径；服务端 / 浏览器旧缓存也不再覆盖当前头像。新增 public/uploads/celebs/default-avatars.json 发布映射，今后本地上传会同步更新运行时映射与发布映射，从本地源码重建镜像时头像文件和关联关系会一起进入群晖。",
    kind: "fix"
  }, {
    title: "FIRE 导航图标恢复默认火焰图标",
    desc: "修复历史上本地与线上数据库中 icon:FIRE 保留自定义 fire-gray.svg，导致导航显示波浪线图标。增加一次性数据库迁移，将 FIRE 统一恢复为随镜像发布的 fire.svg / fire-dark.svg，新库与既有库都一致。",
    kind: "fix"
  }, {
    title: "公开仓库净化与自动防泄漏审计",
    desc: "部署配置改为通过 GHCR_IMAGE、HOST_PORT、DATA_DIR、UPLOADS_DIR 环境变量注入，不再写死账号、端口、NAS 路径或硬件限制；出站代理默认关闭，移除数据库初始化中的特定用户名 UID 规则及无引用的用户上传站点素材。新增 npm run audit:public 并接入 GitHub Actions，自动拦截个人账号、本机路径、个人代理、硬编码群晖配置、时间戳用户素材及常见 Token/API Key/私钥。",
    kind: "security"
  }, {
    title: "新增首次部署引导页视觉稿",
    desc: "新增独立的首次部署引导页 HTML 视觉稿，展示服务状态、管理员创建、基础配置步骤及 data/uploads 持久化提示；当前仅供预览，尚未接入首访路由。",
    kind: "feature"
  }, {
    title: "修复 Docker 挂载后全球经济热图国旗缺失",
    desc: "群晖将宿主机 uploads 挂载到 /app/public/uploads 后，旧容器或默认素材复制失败会遮住镜像内置旗帜文件，热图 tooltip 因图片 404 只显示 🌐。上传资源路由现在在挂载目录未找到文件时回读镜像内置 resource-default，保留用户自定义资源优先级，线上默认国旗不再丢失。",
    kind: "fix"
  }, {
    title: "兼容富途 OpenD 主机地址格式",
    desc: "修复设置中误填 http://192.168.x.x 导致容器 TCP 明明可达但 Fire 判断端口未开放的问题。保存设置、读取旧配置和测试连接时统一将 OpenD 主机归一化为纯 hostname/IP，自动去掉协议、端口与路径。",
    kind: "fix"
  }, {
    title: "GHCR 镜像内置富途 OpenD 桥接运行时",
    desc: "修复线上容器 TCP 可连接 OpenD 但测试仍报 spawn python3 ENOENT：生产镜像此前未包含 Python。现在 runner 镜像内置 Python venv 与 futu-api，设置正确的 OpenD 主机和端口后无需手动进入群晖容器安装依赖。",
    kind: "fix"
  }, {
    title: "修复全站冒烟测试安全参数遗漏",
    desc: "冒烟测试此前清空记录和修改邮箱时未携带接口要求的当前密码，误报线上功能失败。现按真实前端安全协议补齐 password / currentPassword，并在 API 文档明确高风险操作的验证字段；全套测试恢复通过。",
    kind: "fix"
  }]
};

export const V0_1_19_ENTRY: VersionEntry = {
  ...V0_1_18_ENTRY,
  version: "v0.1.19",
  date: "2026-08-31",
  summary: "统一本地与线上资源，并修复导入、行情和即时偏好同步。",
  software: V0_1_18_ENTRY.software.map((item) => item.name === "Fire" ? { ...item, version: "v0.1.19" } : item),
  changes: [{
    title: "线上与本地欧元默认旗帜统一为欧盟 SVG",
    desc: "欧元市场码 EU 不再回退到通用 eu.svg，货币选择器、市场图标、全球经济热图与素材库统一使用 /uploads/asset/flag/欧盟EU.svg。新增既有数据库一次性迁移，仅替换旧内置 eu.svg，不覆盖用户上传的其他自定义旗帜；新部署会以 EU 代码播种该素材，Docker 镜像同步携带并在 uploads 挂载缺失时从 resource-default 兜底。",
    kind: "fix"
  }, {
    title: "个人资料与用户管理现代化精简",
    desc: "移除个人信息编辑态昵称与登录邮箱输入框中的示例占位文字，避免把提示误当作已有资料；用户管理由高占位宽表重构为紧凑成员列表，顶部概览总用户、在线与管理员数量，身份区合并昵称、登录名、UID 与状态，操作统一为带无障碍说明的图标按钮；窄屏自动转为完整卡片布局，不再依赖横向滚动。",
    kind: "fix"
  }, {
    title: "修复移动端订单工具栏溢出与失效素材破图",
    desc: "订单导入、导出与列设置工具在 390px 手机端改为独立自适应工具行，搜索框占满一行并将次要文字按钮收为图标，避免超出右边界；站点 Logo、首页背景与动态 favicon 增加加载失败回退，素材库股票/市场图标容器补齐深色背景，避免 404 破图与深色模式白底突兀。",
    kind: "fix"
  }, {
    title: "移除固定测试用户身份判断",
    desc: "全量审计用户认证、权限与数据查询链路，移除生产登录流程中针对固定 demo-user ID 与公开默认密码的特殊分支；现在管理员权限仅由数据库 role 决定，UID、用户名和内部 ID 均不再被当作特殊账号。保留开发环境种子账号与历史订单数据迁移作为明确的测试/数据修复用途。",
    kind: "security"
  }, {
    title: "完成响应式排查收尾",
    desc: "按 390px 手机、820px 平板与 1440px 桌面复核主要页面：资产分析账户资产卡的分享/刷新按钮补足 36px 触控热区，图标视觉尺寸保持不变；手机与平板顶部横向导航增加右侧边缘渐隐提示，用户能明确知道还可继续滑动。",
    kind: "fix"
  }, {
    title: "导入自选股分组改为幂等并自动合并历史重复项",
    desc: "网站数据导入不再为每个备份分组无条件生成新 ID：市场分组按市场代码、自定义分组按规范化名称复用现有实体，同一备份中的重复项也只保留一份。读取分组时会把历史重复记录迁移到最早的规范分组后删除重复项，既有线上数据无需再次导入即可恢复整洁。",
    kind: "fix"
  }, {
    title: "本地源码与 GHCR 默认素材统一",
    desc: "恢复并发布完整国家旗帜、券商图标与四种贵金属 SVG；素材播种同时扫描 public/uploads 和镜像 resource-default，持久化目录缺文件时仍能从镜像默认资源恢复。素材库统一显示美股及更多市场中文名，地图国名改为中文并在 SVG 不可用时回退真实旗帜 emoji；部署审计新增旗帜、券商、贵金属数量与运行时兜底检查，防止本地正常但线上缺失再次发生。",
    kind: "fix"
  }, {
    title: "显示货币即时同步并补齐线上股票行情",
    desc: "全站共享偏好增加同标签页与跨标签页变更通知，持仓、FIRE 与资产分析切换显示货币后立即重算，无需刷新页面；清理旧的原始 localStorage 写法，统一 JSON 持久化格式。素材库股票行情在本地缓存数据缺失时按市场复用全球预览行情源补齐市值、最新价与涨跌幅，解决干净线上数据库只显示横线的问题。",
    kind: "fix"
  }, {
    title: "统一本地与线上发布节奏并新增状态监控页",
    desc: "main 提交继续执行公开仓库、部署一致性与 TypeScript 检查，但不再每次提交都发布 GHCR；工作流改为北京时间每天 00:00 自动构建发布，并保留 workflow_dispatch 手动兜底。新增 /deploy-status 与 /api/deploy-status，展示最近运行的提交、触发方式和时间，绿色圆点表示成功、灰色表示排队/进行中、红色表示失败，页面每分钟自动刷新。",
    kind: "feature"
  }, {
    title: "发布状态页增加手动推送与可视化流程",
    desc: "状态页新增“立即手动推送”操作，服务端安全调用 GitHub Actions workflow_dispatch 发布 main 最新提交，浏览器不接触 GitHub Token；增加本地源码、检查、定时/手动、GHCR、线上容器五段流程图，并提供触发中、成功和失败反馈。",
    kind: "feature"
  }, {
    title: "发布监控页右上角增加浅色/深色切换",
    desc: "复用全站 ThemeToggle，在 /deploy-status 页面右上角提供太阳/月亮图标，主题选择通过现有 localStorage 与 Cookie 持久化，刷新后保持一致。",
    kind: "fix"
  }, {
    title: "GitHub OAuth 授权与 Token 安全兜底",
    desc: "发布监控页同时支持 GitHub OAuth 授权和手动 Token 兜底。OAuth 使用一次性 state、管理员权限和 workflow 最小权限；授权及备用 Token 仅服务端保存，并通过 DEPLOY_STATUS_SECRET 使用 AES-GCM 加密，页面只显示授权账号/已配置状态。",
    kind: "security"
  }, {
    title: "修复发布监控页浅色主题不生效",
    desc: "监控页面板、流程节点、边框、按钮和运行列表补齐浅色/深色双主题样式，右上角 ThemeToggle 现在会即时改变整个页面并在刷新后保持。",
    kind: "fix"
  }, {
    title: "发布监控页工具栏统一图标操作",
    desc: "刷新、GitHub 授权、配置账号和立即推送统一改为带悬停提示与无障碍名称的图标按钮，减少顶栏占用并保留推送中状态反馈。",
    kind: "fix"
  }, {
    title: "修复本地版券商及同类素材图标丢失",
    desc: "券商素材播种同时校验本地文件，自动修复历史 stock/GROUP 错路径和缺失文件，并按券商名称/别名重建当前分组映射；素材 API 不再下发磁盘与默认资源中都不存在的 URL，全站统一转入已有兜底；素材缓存升级版本，旧缓存会立即后台刷新。",
    kind: "fix"
  }, {
    title: "恢复我的持仓编辑中丢失的券商分组",
    desc: "新增一次性幂等迁移，保留现有券商配置与顺序，并从未丢失的券商素材记录中追加恢复被覆盖的券商；迁移完成后会写入标记，之后手动删除券商不会被自动恢复。",
    kind: "fix"
  }, {
    title: "全站素材与站点形象完整性修复",
    desc: "清理股票与加密货币素材表中已不存在的本地 URL，保留名称/代码供默认图标或 CDN 兜底；股票默认播种不再写入未打包的文件地址；首页背景、登录侧图、favicon 与 Logo 在本地文件丢失时自动回退内置样式；券商下拉图标增加加载失败首字母兜底。",
    kind: "fix"
  }, {
    title: "发布监控页刷新按钮增加动效",
    desc: "刷新图标悬停时以轻量旋转动画反馈操作，保持顶栏简洁并强化可发现性。",
    kind: "fix"
  }, {
    title: "发布流程节点改为可操作按钮",
    desc: "流程图中的 main、检查、立即发布、GHCR 与线上容器节点均可直接操作或跳转，状态检查和手动发布无需离开监控页。",
    kind: "feature"
  }, {
    title: "发布监控页主题与刷新交互打磨",
    desc: "展开的 GitHub 配置区补齐浅色/深色背景、边框、输入框和操作按钮对比度；刷新按钮支持点击期间禁用并持续旋转，减少重复请求并强化反馈。",
    kind: "fix"
  }, {
    title: "发布流程与刷新动画改为柔和过渡",
    desc: "刷新仅在点击请求期间旋转，使用平滑缓动曲线；流程按钮增加自然的悬停与按下过渡，避免状态切换生硬。",
    kind: "fix"
  }, {
    title: "优化发布配置保存按钮文字对比度",
    desc: "保存配置按钮在浅色主题使用深蓝底白字，在深色主题使用亮蓝底深色字，并补充悬停与按下反馈，提升可读性。",
    kind: "fix"
  }, {
    title: "深色模式保存配置改为白底黑字",
    desc: "深色模式下保存配置按钮使用白色背景与深色文字，并补充键盘焦点环，提升对比度和可访问性。",
    kind: "fix"
  }, {
    title: "修正手动 Token 权限提示",
    desc: "网页配置将备用 Token 明确为发布 Token，提示手动触发 workflow 需要目标仓库 Actions 的 Read and write 权限，并同步更新环境变量示例。",
    kind: "fix"
  }, {
    title: "修复网页 GitHub 配置仍返回 API 404",
    desc: "发布状态读取统一使用网页保存的 OAuth 或手动 Token，网页配置的仓库优先于环境变量与 GHCR 镜像推导值；错误信息同时显示实际请求仓库，解决私有仓库和占位环境变量导致的 404。",
    kind: "fix"
  }, {
    title: "发布记录改为每页 10 条",
    desc: "发布监控页最多读取最近 50 次运行并按每页 10 条分页，增加总数、当前页与上一页/下一页控制；窄屏页头改为纵向排列，避免标题与操作图标拥挤。",
    kind: "fix"
  }, {
    title: "修复深浅色切换短暂延迟",
    desc: "主题按钮点击时同步更新根节点 class、持久化设置和 Cookie，不再等待 React 副作用；发布监控页移除整页颜色缓动，主题即时生效。",
    kind: "fix"
  }, {
    title: "修复提交检查被误显示为发布成功",
    desc: "顶部最新发布状态仅统计定时 schedule 与手动 workflow_dispatch 运行，普通 main 提交的检查成功不再被误判为镜像发布成功。",
    kind: "fix"
  }, {
    title: "重排发布状态圆点与说明",
    desc: "最新发布状态圆点与标题改为同一基线，提交与时间独立缩进；成功和失败保持静态，仅排队/进行中使用呼吸动效，底部文字说明改为三个醒目的圆点状态标签。",
    kind: "fix"
  }, {
    title: "发布监控页支持一键更新群晖容器",
    desc: "GHCR 部署增加受限 Watchtower 服务，发布流程可由管理员直接拉取最新 Fire 镜像并观察重启与健康恢复。更新器仅匹配 Fire 专属 enable 标签与 scope，API 只在 Compose 内网开放并使用 32 位以上随机 Token；网页服务端固定调用更新端点，不接收任意命令、容器或镜像参数，并限制 30 秒内重复触发。Compose 配置变化仍需群晖手动执行 compose up。",
    kind: "security"
  }, {
    title: "修复发布监控页手机端头部错位",
    desc: "390px 手机端将发布状态标题、简短说明与工具图标拆成稳定的三层布局，缩短移动端文案并统一左右边距；发布流程改为两列触控网格，隐藏造成断行的箭头，按钮保持单行且不再互相挤压。桌面端完整标题、说明与横向流程保持不变。",
    kind: "fix"
  }, {
    title: "阻止重复触发手动发布",
    desc: "顶部推送图标与流程中的立即发布按钮共享 GitHub 运行状态：已有 workflow_dispatch 排队或运行时同时禁用并显示发布进行中。服务端触发前再次查询当前工作流，并增加 30 秒触发锁，防止快速连点、多标签页或网络延迟产生重复运行；失败或完成后仍可正常重试。",
    kind: "fix"
  }, {
    title: "明确 Push image 镜像构建入口",
    desc: "发布流程将原先含义模糊的立即发布明确命名为 Push image，点击后生成并推送 GHCR 镜像；原构建 GHCR 链接改为查看 GHCR，顶部图标、流程按钮与最近运行记录使用一致名称并继续共享防重复保护。",
    kind: "feature"
  }, {
    title: "统一发布操作并优化刷新反馈",
    desc: "删除顶部重复的镜像推送快捷按钮，镜像构建统一从发布流程中的 Push image 执行；流程节点加入同一套语义图标并统一尺寸、圆角、聚焦与深浅色状态，删除按钮下方的冗余操作提示。刷新按钮改为点击后平滑旋转一圈，移除叠加动画导致的漂移和突停。",
    kind: "fix"
  }, {
    title: "GitHub 授权改为新窗口打开",
    desc: "右上角与配置面板中的 GitHub OAuth 入口统一使用新窗口打开，并补充安全的 noreferrer 属性和无障碍提示，避免离开发布监控页面。",
    kind: "fix"
  }, {
    title: "新增镜像构建实时进度",
    desc: "Push image 后从 GitHub Actions Jobs API 读取真实构建状态，在发布页展示 TypeScript 检查与 linux/amd64 镜像发布两个阶段；运行中的 Job 默认展开，可继续查看 Checkout、GHCR 登录、Buildx 与 Build and push 等步骤、状态和耗时。构建期间每 10 秒刷新，完成后恢复每分钟刷新，并对 Job 数据分级缓存以控制 GitHub API 用量。",
    kind: "feature"
  }, {
    title: "打磨镜像构建进度交互",
    desc: "构建进度增加已完成阶段计数，Job 摘要直接显示当前执行步骤；运行中与失败阶段使用克制的语义边框区分，跳过步骤不再误显示为等待中。修正其他 workflow_dispatch 任务误锁定 Push image 的前端判断，并为动态状态、成功提示和错误提示补充无障碍播报与浅色模式文字对比。",
    kind: "fix"
  }, {
    title: "发布状态改为三段版本校验",
    desc: "发布监控不再把单次构建成功等同于上线完成。页面分别读取 GitHub main、最近可用 GHCR 镜像与当前容器的完整提交 SHA，明确显示检查中、构建失败、镜像落后、待更新和版本一致；群晖更新仅对当前 main 的已验证镜像开放，更新后必须以健康接口返回的运行 SHA 完成校验。镜像写入构建 SHA 与 OCI revision，修复完成任务仍显示构建中的缓存，并隔离提交检查与正式发布的并发取消范围。",
    kind: "security"
  }, {
    title: "收敛发布流程绿色状态语义",
    desc: "GitHub main 改为中性灰色来源节点，检查结果作为子项独立显示；绿色仅用于当前 main 镜像构建完成，以及群晖实际运行该镜像且健康的可验证结果，避免把源码存在误读为发布成功。",
    kind: "fix"
  }, {
    title: "精简发布记录与 GHCR 入口",
    desc: "最近运行由每页 10 条收紧为 5 条；移除发布流程标题旁的文字型 GHCR 入口，改为右上角 GitHub 授权按钮右侧的独立包仓库图标，减少重复文字与视觉干扰。",
    kind: "fix"
  }, {
    title: "继续打磨发布监控页信息层级",
    desc: "发布流程保持原有页面宽度；GHCR 入口换为更简洁的单包图标，移除重复状态图例。GitHub API 异常时仍保留服务端返回的实际仓库名，避免顶部链接退回 owner/repository 占位地址。",
    kind: "fix"
  }, {
    title: "发布监控补齐真实加载与更新器在线状态",
    desc: "首次读取 GitHub 运行记录时显示与最终列表结构一致的骨架行，不再短暂误报待发布或暂无记录；群晖更新器状态由仅检查 Token 改为同时探测 Compose 内网端口，fire-updater 未启动或网络不可达时按钮提前显示更新服务离线，不再等点击后才报错。",
    kind: "fix"
  }, {
    title: "重排线上镜像版本徽章",
    desc: "移除流程末尾重复的线上旧镜像节点，起点改为 fire-web main，并将当前容器实际运行的短 SHA 放到该节点右上角的 GitHub 风格胶囊中；镜像与 main 一致时显示绿色圆点和‘镜像已构建完成’。",
    kind: "fix"
  }, {
    title: "暂停 GHCR 自动清理",
    desc: "暂停自动删除历史镜像，避免多标签 manifest 被误删导致 registry 返回 manifest unknown；待验证更安全的按摘要清理方案后再恢复保留策略。",
    kind: "fix"
  }, {
    title: "定时任务跳过无变化镜像",
    desc: "每日凌晨仍会执行源码与安全检查，但仅当 main 相比上次成功的定时或手动发布发生新提交时才构建镜像；手动 Push image 继续作为强制发布兜底。",
    kind: "fix"
  }, {
    title: "提升 GHCR 镜像清单兼容性",
    desc: "发布镜像时关闭额外 provenance 与 SBOM 清单，保留标准 linux/amd64 镜像，兼容群晖 Docker 拉取并避免 registry 返回 manifest unknown。",
    kind: "fix"
  }, {
    title: "统一发布版本胶囊视觉",
    desc: "线上版本短 SHA 改为 GitHub 风格中性胶囊，浅色模式使用黑色文字，深色模式使用白色文字；版本是否落后仅由状态圆点表达，移除整块橙色告警感。",
    kind: "fix"
  }, {
    title: "移除发布流程重复版本提示",
    desc: "当前线上 SHA 已由 fire-web main 节点右上角胶囊展示，镜像未覆盖最新 main 时，构建节点改为‘构建新镜像’，不再重复显示‘镜像落后 + 相同 SHA’。",
    kind: "fix"
  }, {
    title: "收紧发布监控页临界宽度",
    desc: "桌面内容区由 800px 收紧至 720px，在四段发布流程仍能稳定保持单行的前提下减少横向空白；更窄视口继续使用现有响应式网格。",
    kind: "fix"
  }, {
    title: "按实际构建结果显示镜像状态",
    desc: "只要最近一次镜像构建成功，流程节点即显示绿色圆点与‘镜像已构建完成’；main 后续新增提交不再把已成功构建的镜像显示为落后，版本差异仍由更新按钮可用性控制。",
    kind: "fix"
  }, {
    title: "修复线上版本胶囊越界",
    desc: "将当前线上版本胶囊从 main 节点的负定位悬浮层移到发布流程标题行右侧，保留 GitHub 风格与状态圆点，同时避免越过节点边框、挤压流程箭头或影响 720px 布局。",
    kind: "fix"
  }, {
    title: "统一发布页中文操作文案",
    desc: "将 Push image、镜像发布提示和顶部说明统一为中文表达，保留 GitHub、GHCR 等专有名词，减少中英文混排造成的阅读跳跃。",
    kind: "fix"
  }, {
    title: "修复发布接口 HTML 解析报错",
    desc: "发布页统一校验 API 响应类型；接口返回 404、登录页或其他 HTML 时显示明确的 HTTP 与容器版本提示，不再暴露 Unexpected token 解析错误，也不再同时显示成功和错误提示。",
    kind: "fix"
  }, {
    title: "新提交恢复待构建状态",
    desc: "上一轮镜像仅在与当前 main 匹配时显示绿色完成；main 出现新推送后切换为橙色‘立即构建’，并隐藏已过期的上一轮完成进度卡。",
    kind: "fix"
  }, {
    title: "自动恢复更新服务状态",
    desc: "发布页每 15 秒复检一次 fire-updater，手动刷新时也同步检查；更新服务后启动无需重开页面即可由离线恢复，并统一显示明确的离线文案。",
    kind: "fix"
  }, {
    title: "显示 Watchtower 在线状态",
    desc: "复用发布流程末端的更新节点，以灰、绿、红圆点分别表示 Watchtower 检测中、在线和离线；已是最新时显示‘更新服务在线’，避免新增元素挤压 720px 布局。",
    kind: "fix"
  }, {
    title: "区分等待检查与状态未知",
    desc: "main 新提交已出现但 GitHub Actions 运行记录尚未生成时显示橙色‘等待检查’，并临时提高到每 10 秒刷新；只有 main 本身无法读取时才显示‘检查未知’。",
    kind: "fix"
  }, {
    title: "精简线上版本胶囊",
    desc: "线上版本仅在匹配最新 main 时显示绿色圆点，非最新版统一使用灰色圆点；边框改为轻量内描边与中性底色并移除浮起阴影。",
    kind: "fix"
  }, {
    title: "增加运行次数数字徽标",
    desc: "最近运行标题旁以紧凑圆形徽标显示 GitHub Actions 总运行次数，仅保留数字；同时将单次读取上限提高到 100，使页面分页数量与 GitHub 总数一致。",
    kind: "fix"
  }, {
    title: "修复最新版镜像误判",
    desc: "GitHub 提交详情接口读取失败时，改用最新 main push 运行的完整 head SHA 作为回退，避免同一版本被错误显示为检查未知、立即构建和线上非最新。",
    kind: "fix"
  }, {
    title: "明确容器最新状态",
    desc: "发布流程末端的绿色圆点继续代表 Watchtower 在线；线上已运行最新镜像时文字改为‘容器已是最新’，并取消禁用态整体变淡，保持状态圆点清晰。",
    kind: "fix"
  }, {
    title: "精简更新服务状态文案",
    desc: "发布流程末端在有可更新镜像时显示‘有新镜像’，离线与检测状态分别精简为‘服务离线’和‘服务检测中’，绿、红、灰圆点继续表达服务状态。",
    kind: "fix"
  }, {
    title: "区分最近运行成功类型",
    desc: "最近运行列表中，定时或手动镜像构建成功使用绿色圆点，main 推送检查成功使用蓝色圆点，便于快速区分发布与检查记录。",
    kind: "fix"
  }, {
    title: "统一美股名称并修复货币选择器越界",
    desc: "首页、我的持仓和素材库内置 US 市场统一显示‘美股’，不再受历史自定义标签影响；持仓盈利图货币选择器在窄卡片与窄屏下限制宽度并允许操作区换行，边框不再超出容器。",
    kind: "fix"
  }, {
    title: "稳定全球经济最新年份",
    desc: "全球经济数据不再依赖 World Bank 返回记录的顺序，而是对每个国家明确选取查询范围内的最大年份，避免本地与线上因响应顺序不同显示不同年份或数值。",
    kind: "fix"
  }, {
    title: "修复加密货币市值冷启动",
    desc: "全球市值榜首次加载时等待 CoinGecko 市值行情补齐，并对缓存中缺失市值的加密货币自动刷新，避免 BTC、ETH 等项目以 0 市值落到第 99、100 位。",
    kind: "fix"
  }, {
    title: "增加加密货币市值备用来源",
    desc: "CoinGecko 返回价格但缺少市值时，使用 CompaniesMarketCap 全球资产榜中的加密货币市值补齐，避免限流或字段缺失再次产生 0 市值条目。",
    kind: "fix"
  }, {
    title: "自选股与持仓支持加密货币搜索",
    desc: "添加持仓和自选股时，统一搜索入口同步返回 CoinGecko 加密货币候选，可直接保存为加密货币记录并在结果中明确标注资产类型；股票搜索源不可用时不受影响。",
    kind: "feature"
  }, {
    title: "补齐加密货币 K 线",
    desc: "加密货币详情页 K 线改用 CoinGecko 历史价格数据，支持 BTC、ETH、SOL 等主流币种的日 K 展示。",
    kind: "fix"
  }, {
    title: "替换 BTC/ETH 高清开源图标",
    desc: "素材库比对多个开源集合后，采用 cryptocurrency-icons 的 CC0 彩色 SVG 替换比特币与以太坊图标，统一圆角容器下的清晰度与视觉风格。",
    kind: "feature"
  }, {
    title: "修复加密货币图标错配",
    desc: "素材播种会修复历史上 ETH 指向比特币图标的错误映射，同时保留用户手动上传的自定义图标不被覆盖。",
    kind: "fix"
  }, {
    title: "补齐 ADA/BCH 加密货币图标",
    desc: "补充艾达币与比特币现金高清开源 SVG，避免缺少素材时错误回退为比特币符号。",
    kind: "fix"
  }, {
    title: "行情板复用加密货币素材图标",
    desc: "自选股与我的持仓列表不再只查股票图标；ASSET 加密货币记录改为复用素材库 crypto 图标。",
    kind: "fix"
  }, {
    title: "搜索结果补充市场色块",
    desc: "我的持仓与自选股搜索候选使用与资产分析持仓明细一致的市场色块，股票与加密货币市场标识更直观。",
    kind: "feature"
  }, {
    title: "搜索结果紧凑化",
    desc: "市场色块统一为紧凑固定尺寸，股票名称与代码设置最大宽度并截断，长名称不会撑破搜索结果行或挤压价格区域。",
    kind: "fix"
  }, {
    title: "加密货币增加专属色块",
    desc: "市场色块统一为琥珀色‘币’标识，加密货币在搜索结果、持仓与自选股中与股票市场清晰区分。",
    kind: "feature"
  }, {
    title: "优化加密货币色块文字对比",
    desc: "加密货币琥珀色标签改用更干净的深墨色文字，提升小尺寸色块的可读性与 GitHub 风格一致性。",
    kind: "fix"
  }, {
    title: "加密货币色块改用白色字体",
    desc: "搜索框及持仓相关市场色块统一使用白色‘币’文字，搭配深琥珀底色，避免黑字观感不一致。",
    kind: "fix"
  }, {
    title: "发布状态页增加更新热力图与权限守卫",
    desc: "发布状态页新增最近一年 GitHub 风格更新热力图，固定显示 1–12 月且在容器内自适应不产生横向滚动；每日、每周、每月、累计视图均保留相同的每日小点网格，周/月模式点击日期会联动高亮对应整周/整月并显示汇总 workflow 次数，更新越多绿色越深；手机端格子改为等宽等高的方形圆角点，避免竖条变形；持仓页货币选择改为受控更新，消除首次切换欧元/韩元的事件同步延迟；镜像构建成功且确认有新镜像后自动倒计时 5 分钟触发 Watchtower 容器更新；立即构建改为舒缓绿色呼吸圆点，手机端工具按钮右对齐；页面增加服务端管理员守卫，非管理员统一返回 404。",
    kind: "feature"
  }, {
    title: "全站数据表手机端横向浏览修复",
    desc: "统一修复持仓与全球排行货币菜单贴边溢出、自选行情板股票首列消失、全球资产涨跌幅与市值拥挤、素材库股票序号及加密货币名称被压缩等问题；数据表保留合理最小列宽并支持横向滑动，FIRE 未来年度盈利占位统一为红色。",
    kind: "fix"
  }, {
    title: "手机端溢出审计第二轮",
    desc: "显示货币菜单在手机端统一改为底部安全区面板，彻底避免左右边缘越界；API 文档、财报附件与截图导入预览表补齐最小列宽和横向滚动，不再压缩长路径、文件名或金额列。",
    kind: "fix"
  }, {
    title: "纠正手机端行情表与货币菜单交互",
    desc: "自选行情板将股票图标与名称列固定在手机端左侧，横向查看价格与走势时身份信息不再消失；全球资产排行明确恢复现价列并用固定列宽完整横滑；显示货币菜单恢复到触发按钮旁，不再远离当前操作。",
    kind: "fix"
  }, {
    title: "完成七项手机端回归检查",
    desc: "全球资产排行的货币入口与标题并排显示，弹层紧邻入口；素材库分类标签改为不压缩的横向滑动栏并收紧手机端卡片留白，避免分类被裁切，同时复核发布页、持仓、自选股、FIRE 与数据表横滑规则。",
    kind: "fix"
  }, {
    title: "全球资产排行强制保留完整七列",
    desc: "手机端不再依赖原生 table 自动分配宽度，改为固定七列 Grid：排名、资产、现价、涨跌幅、迷你趋势图、市值、市场全部保留，由外层统一横向滑动；同步复核全站宽表，并为操作日志、订单导出记录和导入预览补齐明确最小宽度与独立滚动容器。",
    kind: "fix"
  }, {
    title: "修复嵌套分栏内宽表无法触摸横滑",
    desc: "定位资产分析持仓表虽有 overflow-x 但触摸手势被外层分栏接管的问题；新增全站 data-table-scroll 手势规范与 pan-x 惯性滚动，覆盖持仓、自选、全球排行、FIRE、日志、订单、API 文档及所有 overflow-x-auto 区域。通过 iPhone 12 Pro 390px 浏览器逐页复现并移除旧版 ≤420px 强制删列规则：我的持仓、资产分析、自选行情、全球资产、日志、素材库、名人持仓及首页预览在所有手机尺寸统一保留完整列并内部横滑。",
    kind: "fix"
  }, {
    title: "取消宽表横向冻结列",
    desc: "通过 iPhone 12 Pro 视口实测并全站扫描横向 sticky 列；取消自选行情左侧股票列和右侧操作列的冻结定位、层级与阴影，清理深色编辑模式残留的冻结投影及序号列隐藏兜底，所有列随表格自然横滑。保留移动导航、附件表头和弹窗标题等正常的纵向吸顶交互。",
    kind: "fix"
  }, {
    title: "修复个股详情图表工具栏文字挤压",
    desc: "通过 iPhone 12 Pro 视口定位图表工具栏左侧周期组被 Flex 压缩至 41px 的问题；手机端改为周期与图表操作上下分区，K 线周期在自身区域平滑横滑，复权、比较、图形和指标按钮保持完整文字，极窄屏允许操作组自然换行。顶部行情指标改为默认隐藏，可按需显示为 2×2 卡片；时段、周期、复权、比较、图形和指标选择框统一使用视口内底部安全面板，解决弹层越界；移动断点按视口将 K 线高度收敛至约 220–300px，避免手机图形纵向占位过大；详情头部同步缩小返回键与图标、截断过长名称、隐藏重复代码并收紧价格排版；手机 K 线悬浮框改为紧凑的收盘/涨跌信息，避免遮挡图形。",
    kind: "fix"
  }, {
    title: "小屏货币金额紧凑显示与全局单位设置",
    desc: "韩元、日元等高面额货币在小屏持仓与资产分析卡片中自动按万、百万、千万、亿缩写，避免净资产、当日盈亏和持仓市值溢出；桌面默认保持原完整金额。股票设置新增‘跟随设备（小屏缩写）/始终缩写/始终完整’切换，并在同标签页即时同步。",
    kind: "feature"
  }, {
    title: "富途额度查询增加 OpenD 快速预检",
    desc: "查询富途 OpenAPI 额度前先进行 800ms TCP 端口检测；OpenD 未启动或地址不可达时立即返回，不再启动 futu-api 并等待内部重连。桥接进程原有 10 秒硬超时继续作为网关可达但 SDK 异常时的第二层保护。",
    kind: "fix"
  }, {
    title: "区分历史成交记录与实时委托",
    desc: "资产分析持仓交易弹窗新增‘提交委托 / 记录已成交’双模式。历史成交按交易所当地时间录入，美股明确使用美东时间并禁止未来时间；实时限价单不再因当日有效而直接成交，未到价保持待成交并由实时行情触发。同步修复当日有效挂单跨交易日不失效，以及挂单成功提示误判为已成交的问题。",
    kind: "fix"
  }, {
    title: "收紧委托有效期、交易所日期与导入兼容",
    desc: "订单服务拒绝未知订单类型与时效，自定义有效期按交易所自然日截止并禁止选择过去日期，挂单卖出在创建阶段校验可卖数量；今日/历史订单按各交易所当地日期归类。历史成交补录增加夏令时不存在时刻校验，旧版无 mode 请求继续按当前时间成交；备份导入完整保留六种委托类型与 custom 时效。",
    kind: "fix"
  }, {
    title: "设置搜索统一为单实例响应式面板",
    desc: "移除桌面侧栏与手机内容区重复渲染的两套搜索面板，解决共用 ref 导致桌面焦点可能落到隐藏输入框的问题；统一面板按视口自适应宽度，并补齐组合框/列表框语义、悬停选择、空结果提示、方向键边界、回车跳转和 Escape 关闭。",
    kind: "fix"
  }]
};

export const V0_1_20_ENTRY: VersionEntry = {
  ...V0_1_19_ENTRY,
  version: "v0.1.20",
  date: "2026-09-03",
  summary: "空实例首次设置接入真实流程，设置标题栏保存当前分区，交易广场本地缓存动态，正文股票代码可点开详情。",
  frontend: [
    ...V0_1_19_ENTRY.frontend,
    { name: "react-photo-view", version: "1.2.7", desc: "交易广场配图页内预览（官方组件 · 手势 / 工具栏缩放）" }
  ],
  software: V0_1_19_ENTRY.software.map((item) => item.name === "Fire" ? { ...item, version: "v0.1.20" } : item),
  changes: [{
    title: "空实例首次设置接入真实三步向导",
    desc: "生产空库不再只依赖登录页注册。无非测试用户时，访问登录或后台会进入 /setup：创建管理员、填写站点标题与注册开关、然后开始使用。关闭注册时仍允许创建首位管理员；已初始化实例访问 /setup 会回到登录或后台。公开接口 GET /api/auth/setup-status 与 /api/v1/auth/setup-status 只返回 needsSetup 布尔值。",
    kind: "feature"
  }, {
    title: "设置标题栏完成改为真正保存当前分区",
    desc: "设置窗口标题栏对勾从“退出编辑”改为保存当前分区；站点信息、形象、指数、导航、来源、翻译、富途与数据库的卡片按钮同步走同一提交链路。保存失败保留编辑态，避免未写入就退出。",
    kind: "fix"
  }, {
    title: "交易广场改为本地缓存优先的社交动态",
    desc: "交易广场展示特朗普 Truth Social 与段永平雪球公开动态：页面先读本地 JSON，访问时按设置频率后台刷新；支持人物切换、拖动压缩布局、近一个月归档分页与中文翻译。设置中可分别配置两位作者的更新间隔。",
    kind: "feature"
  }, {
    title: "翻译服务统一为大模型配置且密钥不下发浏览器",
    desc: "设置新增独立翻译服务分区，统一 llmProvider / llmApiUrl / llmModel / llmApiKey；已保存的 API Key 只返回配置状态与掩码占位，不再把明文密钥发给页面。",
    kind: "security"
  }, {
    title: "交易广场补齐中文翻译、刷新与浏览记忆",
    desc: "特朗普动态的翻译改为只处理尚未翻译的帖子，不再被已有译文占满前 5 条名额；访问页面后会后台继续补译，并在刷新完成后自动更新列表。人物、分类和页码写入 URL，时间显示到分钟，分页改为可跳转页码；头像跟随名人持仓自定义图。",
    kind: "fix"
  }, {
    title: "交易广场刷新不再堵住页面加载",
    desc: "打开或刷新交易广场时立刻返回本地缓存；归档抓取改为增量（已有缓存只翻到与旧帖重叠），翻译改到后台小批量进行，不再等 30 页归档和模型翻译结束才出列表。再次进入会先画出上次缓存内容。",
    kind: "fix"
  }, {
    title: "段永平动态改为近三个月并带上引用原话",
    desc: "雪球时间线窗口从 30 天扩到 90 天；回复/转发会带上被 @ 的原评论或原帖，热门里不再只看到一句没有上下文的回复。抓取同时尝试 xueqiu.com 与 api.xueqiu.com，并复用会话 Cookie。",
    kind: "feature"
  }, {
    title: "交易广场取消按天数截断历史动态",
    desc: "特朗普与段永平不再只保留近 30 / 90 天。已缓存的旧帖不会被按日期删掉，刷新按分页继续往回补，直到与现有缓存重叠或达到页数上限。",
    kind: "fix"
  }, {
    title: "修复特朗普更早动态不再翻译",
    desc: "未译队列卡在 8/27 一批长帖上：单条 2.5 秒超时失败后每次只重试前 3 条，更早的帖子永远排不上。改为失败冷却并继续往后译，单次最多 20 条、模型超时 12 秒，打开交易广场就会从第 14 页缺口继续补中文。",
    kind: "fix"
  }, {
    title: "特朗普新帖先翻译再进列表，大模型优先",
    desc: "新抓到的特朗普动态先走大模型翻译，失败再兜底 MyMemory，译文写入本地 JSON 后才进入 feed。页面不会先闪英文再换成中文；已显示的中文刷新时也不会被原文顶掉。",
    kind: "fix"
  }, {
    title: "操作日志分类检索并纳入交易活动",
    desc: "系统日志增加分类、搜索、分页与深浅色对比；认证审计与交易活动写入同一日志，并按市场拆分前一日盈亏摘要。",
    kind: "feature"
  }, {
    title: "交易广场正文股票代码和链接可点开个股详情",
    desc: "动态正文里的雪球 $名称(代码)$、美元代码、$AAPL 这类标记、雪球/Yahoo/东财股票链接，以及持仓里的代码和名称，都会高亮并可点开同一套个股详情；普通新闻链接仍跳转原文。返回箭头回到当前动态列表，刷新后仍停留在该股票。",
    kind: "feature"
  }, {
    title: "交易广场股票代码加虚线并悬停预览行情",
    desc: "正文里的股票标记改为虚线下划线；鼠标悬停约 0.16 秒后弹出摘要卡，显示名称、代码、现价、涨跌幅、昨收、市值和行情时间，点卡片或文字都进入个股详情。行情走 /api/v1/quotes 并缓存 30 秒，触控设备仍直接点开详情。",
    kind: "feature"
  }, {
    title: "操作日志顶部补市场图标并校正交易记录",
    desc: "用户日志盈利摘要的美股 / 港股 / A 股加上市场图标，金额按当前显示币种换算，不再把不同原币种直接相加。交易记录表「市场」与「方向」列对调回来，价格带货币符号；分页改用全站页码组件，筛选和页码写入 URL。",
    kind: "fix"
  }, {
    title: "日志顶部改为前一日持仓盈利并合并动态",
    desc: "用户日志顶部改为各市场上一交易日收盘相对前收盘的持仓盈亏，带市场图标，并按显示币种汇总。点击美股/港股/A股可筛选下方列表；交易与持仓操作收成一条时间线，筛选增加「交易」。",
    kind: "feature"
  }, {
    title: "日志摘要合计前置并接入统一货币切换",
    desc: "前一日持仓盈利把合计放到第一格，右上角使用全站圆形国旗货币按钮，切换后金额立即按显示币种换算。列表股票列去掉市场图标，只保留代码和市场名。",
    kind: "fix"
  }, {
    title: "日志筛选改为搜索框左侧图标",
    desc: "去掉列表上方单独一行的「全部动态」下拉。筛选改成漏斗图标放在搜索框左边，和刷新收在同一组工具里；选了交易/新增等时图标保持按下态。系统日志模块筛选同样收进这个按钮。",
    kind: "fix"
  }, {
    title: "日志合计图标与市场图标对齐",
    desc: "前一日持仓盈利的合计保持 Σ，做成 14px 圆形图标，与同排美股/港股/A股市场图标尺寸一致，不再使用地球。",
    kind: "fix"
  }, {
    title: "刷新不再闪现右上角登录按钮",
    desc: "已登录用户刷新首页或后台时，右上角改为服务端会话直接渲染头像，不再等 /api/auth/me。检查中不再画出登录按钮；接口超时或 5xx 也保留当前头像，只有 401 才回到登录。全站同类问题一并处理：已登录访问 /login 服务端直接进后台；后台头像遇 401 整页去登录页而不是先闪登录按钮；行情/分组/搜索的瞬时失败不再把人踢去登录页；顶栏指数条刷新先读本地缓存。",
    kind: "fix"
  }, {
    title: "交易广场按人物显示更新时间并提示新动态条数",
    desc: "右侧标题「全部动态」下方显示最近一次抓取时间（取所有人里最新的一次，人再多也不逐条罗列）。新帖数字叠在头像右下角，点进该人物后消失；数字在本地缓存画完之后用已有列表计算，不额外请求、不挡住页面加载。点进某个人时标题下只显示这个人的更新时间。",
    kind: "feature"
  }, {
    title: "交易广场动态展示发帖配图并支持页内缩放预览",
    desc: "特朗普归档附件图与段永平雪球配图在后台刷新时下载到本地 /uploads/trading-square/，列表只加载本地下载成功的图片，不引用外链。预览改用官方 react-photo-view：点击缩略图在当前页按原比例打开，支持双指缩放、拖动、工具栏放大缩小与键盘切换，不新开标签、不挡住列表首次加载。已缓存的旧帖在下次抓取重叠页时补图。",
    kind: "feature"
  }, {
    title: "交易广场配图下载与预览安全加固",
    desc: "配图远程抓取改为 HTTPS 主机白名单（雪球 / Truth Social 归档附件域），拒绝内网、localhost、带用户名的 URL 以及跳转后落到白名单外的地址；落盘前用文件魔数校验，只保存 jpg/png/gif/webp，拒绝 svg/ico；列表与预览只接受 /uploads/trading-square/{作者}/{16位哈希}.{扩展名}，不把外链交给 react-photo-view。npm audit 对新增依赖 0 漏洞。",
    kind: "security"
  }, {
    title: "加快全站首屏：不再每个页面拉取全部股票素材",
    desc: "首页不再同步打进全球预览/财报日历整包；持仓与首页只下发当前记录需要的图标，不再每次扫描 3000+ 素材并下载约 1MB 的 /api/assets?type=stock。完整股票素材库仅在素材库/附件管理打开时加载。素材文件存在性检查加内存缓存，播种只执行一次；指数栏缓存 60 秒；自动备份推迟到首屏之后。",
    kind: "fix"
  }, {
    title: "发布状态热力图月份不再换行错位",
    desc: "更新热力图改为固定 12 列月份块（1月到12月同一行），每个月用自己的周列，避免 53 周滚动网格把当年 9 月挤到 12 月下面。",
    kind: "fix"
  }, {
    title: "无正文的特朗普动态不再送去翻译",
    desc: "纯图片或只剩链接的帖子不再调用大模型/翻译接口，避免模型把「请提供英文内容」这类回复当成译文。已有这类无效译文会在刷新时清掉。",
    kind: "fix"
  }]
};

export const V0_1_21_ENTRY: VersionEntry = {
  ...V0_1_20_ENTRY,
  version: "v0.1.21",
  date: "2026-09-05",
  summary: "资金记录可按股票名称、代码和拼音搜索，现金账与成交订单联动。",
  frontend: [
    ...V0_1_20_ENTRY.frontend,
    { name: "pinyin-match", version: "1.2.10", desc: "中文名 / 拼音首字母 / 全拼搜索" }
  ],
  software: V0_1_20_ENTRY.software.map((item) => item.name === "Fire" ? { ...item, version: "v0.1.21" } : item),
  changes: [{
    title: "资金记录联动股票名称、代码和拼音",
    desc: "资产分析资金记录搜索不再只匹配备注原文：自动记账流水关联成交订单，可用中文名、代码（含港股 700/00700）、拼音首字母（中国移动→zgyd）和全拼查找；同时支持买入/卖出/股息、美股/港股/A股，以及 9月3日 这类日期。列表展示股票代码。",
    kind: "feature"
  }, {
    title: "修复资金记账金额输入抖动",
    desc: "新增资金记录时输入金额不再抖动：彩虹数字改为与输入框同排的连续等宽字，千分位逗号不再让数字节点整串重建；光标固定在末尾且不随逗号插入重启动画；底部「当前余额 / 记账后」行高锁死，弹窗不再跟着数字变长而上下跳动。",
    kind: "fix"
  }, {
    title: "资金记录搜索改为彩虹输入并消除抖动",
    desc: "查看资金记录的搜索框改回逐字彩虹着色；输入法拼写过程不再把拼音中间态送去搜索，彩色字与光标共用同一套内边距，列表区域高度固定，避免边输入边上下跳。",
    kind: "fix"
  }, {
    title: "资金记录标题不再重复股票代码",
    desc: "自动记账流水标题只保留「卖出 中国移动」，代码只出现在右侧胶囊；搜索仍按成交订单的代码、名称和拼音匹配，输入 600941 仍能找到。",
    kind: "fix"
  }, {
    title: "资金记录改为名称加色块胶囊",
    desc: "查看资金记录简化为股票名称，后接统一胶囊：买入浅红底、卖出浅绿底、股息深色块，左侧带圆点；股票代码与「自动」用中性浅底胶囊，深浅色都对齐。",
    kind: "fix"
  }, {
    title: "资金记录搜索框占位超出显示省略号",
    desc: "查看资金记录搜索框回到标题栏右侧原样式；占位「名称、代码、拼音、买入/卖出」宽度不够时用省略号收住，不再换到标题下方。",
    kind: "fix"
  }, {
    title: "资产分析持仓平仓改为市价快卖，并补股息入账",
    desc: "右击平仓仍是卖出，但固定市价单、立刻成交，不再出现当日有效和时段。右击新增股息：不改持仓，可按最近一期每股股息补录；派息日到账仍会自动进订单和资金记录。",
    kind: "fix"
  }, {
    title: "持仓右击股息改为历年一览并可补录缺失",
    desc: "资产分析持仓右击「股息」改为展示该股历年派息：按年份切换，一眼看到每股金额、除息日、派付日，以及已入账 / 待派发 / 未入账。已到派息日但账上没有的，可一键按除息日持仓补录进订单和资金记录。",
    kind: "feature"
  }, {
    title: "股息只从首次买入后入账，并写入订单",
    desc: "自动股息改为按买入/卖出订单重放持股：首次买入之前的派息不再进账，误入账的自动股息会清掉。补录仍按除息日持股写入订单系统和资金记录，历年列表标买入前 / 当时未持仓 / 已入账。",
    kind: "fix"
  }, {
    title: "股息列表增加每期股息率",
    desc: "持仓右击股息与个股股息页每期增加股息率：每股现金股息除以除息日前最近收盘价。没有收盘价时显示 —，不影响入账。",
    kind: "feature"
  }, {
    title: "股息记录改为紧凑表格",
    desc: "持仓右击股息与个股股息页改成同一张密行表格：每股、股息率、除息、派付、状态。美股多期表头固定、区内滚动；港股和 A 股一年一两期不再按年拆成大卡片，页面跟着行数收住。",
    kind: "feature"
  }, {
    title: "日志页改为账户操作时间线",
    desc: "日志页宽度与设置页同为 800px。上方前一日持仓盈亏：一个合计，下面美股/港股/A股三列。下方不再出现持仓或订单，改为登录、改密、导入导出等账户记录，按日浅色分隔；失败红字。买入卖出请到订单。",
    kind: "feature"
  }]
};

export const V0_1_22_ENTRY: VersionEntry = {
  version: "v0.1.22",
  date: "2026-09-06",
  summary: "简化版完成桌面与手机自适应打磨，并补齐正式页面、账本导入导出与收益计算。",
  frontend: [...V0_1_21_ENTRY.frontend, { name: "SheetJS(xlsx)", version: "0.18.5", desc: "简化版投资记账「有知有行」xlsx 导入导出" }],
  software: V0_1_21_ENTRY.software.map(item => item.name === "Fire" ? { ...item, version: "v0.1.22" } : item),
  changes: [{
    title: "修复有知有行累计收益与曲线计算口径",
    desc: "导入时补回首条总资产代表的初始本金，资金流日期同步调整市值；累计收益按期末资产减净投入计算，资金加权收益率改用 Modified Dietz，年化收益率改用 XIRR，汇总曲线按日期携带各账户最新市值。旧版重复种子记录和错误本金会在刷新后自动修正。",
    kind: "fix"
  }, {
    title: "简化版升级为正式无后缀页面",
    desc: "简化版入口改为 /simple-app，浏览器地址不再显示 .html；/simple 与旧 /simple-app.html 自动跳转到新页面，原有账本、导入导出、主题与窗口交互完整保留。",
    kind: "feature"
  }, {
    title: "简化版完成桌面与手机自适应打磨",
    desc: "对照家庭资产与投资记账参考图重新梳理视觉层级：桌面总览拓宽并强化核心金额，卡片、标题、阴影与交互反馈统一；手机端自动铺满视口、隐藏桌面窗口控件、适配安全区和单列卡片，同时补齐键盘焦点与窄屏防溢出处理。",
    kind: "feature"
  }, {
    title: "简化版对照原版继续打磨交互与版式",
    desc: "底部「更新资产」改为窗口页脚固定、不再盖住内容；总览晴雨表、投资入口和家庭/更新页标题栏对齐原版；桑基图与收益率曲线补预期虚线；更新收益弹层改用图形而不是表情；现金流输入不再整页重绘；家庭成员写入服务端账本，Escape 可关闭弹层。",
    kind: "feature"
  }, {
    title: "简化版弹窗改成记一笔样式，并记住当前页面",
    desc: "投资记账「更新收益」以及添加成员、记账提醒、自定义区间都改成居中卡片弹窗：标题说明、分段选择、彩虹金额、底部取消/确认，风格仍跟简化版一致。当前页、成员、账户、分类和弹窗写入地址栏，刷新或前进后退会停在原处。",
    kind: "feature"
  }, {
    title: "简化版更新收益日历复用记一笔选择器",
    desc: "更新收益和自定义区间不再用系统日期框，改为完整版资金「记一笔」同一套日历：按月翻页、周一到周日、选中蓝圆、今天圆点、不可选未来日、一键回到今天。",
    kind: "feature"
  }, {
    title: "简化版投资记账加市场并改用下拉筛选",
    desc: "投资记账「全部资产」改为下拉选择活钱/稳健/长期。添加投资资产增加市场（美股/港股/A股等），图标复用素材库市场图标；列表、详情和设置同步显示。选美股/港股会带上对应币种。",
    kind: "feature"
  }, {
    title: "简化版投资记账支持「有知有行」格式导入导出",
    desc: "「投资记账」页标题栏新增完整版风格切换样式的按钮（堆叠图层图标），点击展开导入/导出菜单：导出 Excel（有知有行格式）/ 导出 JSON / 导入账本（Excel / JSON）。导出的 xlsx 与有知有行投资记账表完全兼容（账户名称、预期年化收益率、币种、四笔钱分类，以及每日总资产与转入转出记录），可来回导入导出；导入按账户名去重、避免重复账户；新增依赖 SheetJS(xlsx) 在服务端解析与生成。导入时按账户名称关键词用正则自动归入对应账本（如「富途」→ 美股（富途）、「长桥」→ 美股（长桥）、「ibkr/盈透」→ 美股（IBKR）、「港A」→ A股（港A）），账户名未命中时可按文件名兜底匹配（如「有知有行_华泰_xxx.xlsx」→ A股（华泰））；关键词库扩充至富途/长桥/IBKR/老虎/雪盈/微牛/嘉信/华泰/中信/招商/国泰君安/银河/广发/东方财富/雪球/且慢/蛋卷/天天基金/蚂蚁/币安/OKX/火币/港A 等；投资列表按账本分组并显示账户数与小计金额。",
    kind: "feature"
  }, {
    title: "修复简化版同页交互整页抖动",
    desc: "简化版 `render()` 每次都会重建整个屏幕，导致打开/收起菜单、切换下拉、筛选、展开更多设置等**同页轻交互**都会重新播放整页入场动画（从下方淡入上移），视觉上整页「跳一下」。修复：仅在**切换页面**（`route.name` 变化）时播放入场动画，同页重渲染为屏幕追加 `noanim` 抑制动画；一次性解决「投资记账」右上角导入/导出、「⋯」家庭成员等所有同页菜单与下拉的抖动问题，页面切换过渡动画保留。",
    kind: "fix"
  }, {
    title: "修复简化版刷新闪现竖向滚动条 / 窗口高度跳变",
    desc: "刷新任意页面后，即使内容能放下，窗口内容区仍闪出一条竖向滚动条（投资记账页因内容多最明显）。根因：1) `applyWin()` 在 `render()` 前执行，窗口高度按空内容计算、随后才异步修正，造成高度迟滞；2) `syncScroll()` 只在首帧算一次（此时内容尚未稳定、`scrollHeight` 偏大），`can-y` 被误设为 true，等内容收敛到刚好放下时没有重算，滚动条被错误残留。修复：把 `applyWin()` 移到 `render()` 之后（首帧窗口高度即贴合真实内容），`render()` 末尾同步调用 `syncScroll()`，并用 `ResizeObserver` 监听内容区尺寸实时重算「是否可滚动」（`can-y`）；现在内容放得下时不出现滚动条、窗口高度贴内容，内容多时才出现滚动条（窗口受视口上限）。并对加载中间态做内容高度稳定判定与 8px 容差：内容仅略高（如图标/字体加载时）不再被判为可滚动，彻底消除「先冒出又缩回」的闪现。",
    kind: "fix"
  }, {
    title: "修复简化版导入有知有行账本：同名账户历史未导入",
    desc: "导入有知有行 xlsx/json 时，若账户名与现有账户相同，`mergeInvest` 直接跳过，导致导入的每日总资产历史、累计转入转出、收益率曲线都不生效（用户已有同名账户时「更新记录」只剩一条、曲线不变，像没导入）。修复：同名账户改为**合并历史**——把导入的每日资产/转入转出按日期并入（导入优先、去重），`amount` 取最新、累计投入/转出**尊重已手动设置的值**（仅当账户尚无投入时才采用导入值；因有知有行的「转入转出」不含建仓初始投入，用户可能已按券商收益手动修正过），同步更新预期收益率/市场/币种；无同名账户时仍按完整历史新建。重新导入即可把有知有行的历史与正确投入并入对应账户。",
    kind: "fix"
  }, {
    title: "简化版投资账户资产构成支持手动编辑投入 / 转出",
    desc: "「资产构成」本质是记录，不必非要较真数据源口径。账户详情页的「资产构成」标题旁新增一支**笔**（参考完整版设置）：默认**只读**，**双击**投入 / 转出进入编辑，或**点笔**进入编辑态（笔高亮、投入/转出框可单击，框上不再重复显示小笔）。填入修正后的累计投入 / 转出（如为与券商收益一致而校正的值），收益（期末 − 净投入）会自动重算；汇总视图仍为只读。同名合并导入历史时尊重已手动设置的投入 / 转出，不被导入覆盖。",
    kind: "feature"
  }, {
    title: "简化版资产构成改为完整版「资金系统」网格样式",
    desc: "账户详情「资产构成」改为**完整版资金系统汇总图的网格样式**（`fund-flow-grid`，3 列）：投入 / 期初金额 / 转出 / 净投入 / 期末金额 / 收益 六张圆角卡片，**期初·净投入·收益**用浅蓝 flow 底、**投入/转出**普通卡、**期末金额**用蓝色渐变 result 高亮；卡片间用 `--muted` 折线（bracket / center-line）连接，金额按正负红绿着色。编辑（标题旁笔 + 双击 / 点笔）保留；去掉了此前引入的 ECharts（该网格为纯 HTML/CSS）。",
    kind: "feature"
  }, {
    title: "修复导入有知有行重名账户（同关键词重复生成）",
    desc: "导入时按账户名精确去重，导致有知有行的「长桥（美股）」与你已有的「美股（长桥）」因名字不同而被当成新账户，同组里出现两个同款（ibkr 同理）。修复：1) 去重改为**按账本组（关键词）匹配**——命中同一关键词（如「长桥」）即视为同一账户，合并历史、不再新建；2) 新增 `dedupeInvestGroups`，导入后自动**合并同一账本组里的重复账户**（保留首个、其余历史并入），清理已产生的重复。重新导入一次即可把「长桥（美股）/ ibkr」合并进「美股（长桥）/ 美股（IBKR）」。",
    kind: "fix"
  }, {
    title: "简化版每个账本（分组）设置里可导入 / 导出",
    desc: "「投资记账」每个账本分组表头右侧新增 ⚙️ 设置按钮，点开显示该账本菜单：**导出 Excel / 导出 JSON / 导入到该账本**。导入到某账本即把文件里的账户归入**该账本**（`group` 由用户指定），不再依赖关键词 / 名称匹配，组内同名账户自动合并历史、不会再生重复；导出只导出该账本的账户。右上角全局导入导出保留（可导入到其他账本）。另：“+ 添加投资资产”文字居中；同组重复去重时**保留与「账本组名」完全一致的规范账户**（如保留 美股（长桥）、删掉 长桥（美股）），按每个用户实际账本名匹配、不写死任何市场规则。",
    kind: "feature"
  }, {
    title: "简化版账户详情「更新记录」默认显示 3 条",
    desc: "投资账户详情的「更新记录」原本默认展开最近 6 条，改为默认只显示**最近 3 条**，需要更多时点「查看更多」展开全部，列表更紧凑。",
    kind: "fix"
  }]
};

export const V0_1_23_ENTRY: VersionEntry = {
  version: "v0.1.23",
  date: "2026-09-07",
  summary: "简化版年度现金流按参考图重做桑基图、编辑流程、分享导出与小屏适配。",
  frontend: V0_1_22_ENTRY.frontend,
  software: V0_1_22_ENTRY.software.map(item => item.name === "Fire" ? { ...item, version: "v0.1.23" } : item),
  changes: [{
    title: "简化版新增年度现金流规划与 ECharts 桑基图",
    desc: "年度现金流仅在首次配置时进入计算器，完成后从总览卡片直接打开年度页；默认展示收入与支出桑基图，放大后可切换收入与支出/仅支出以及金额、比例、隐藏数据，收支、分类支出与年度结余均由同一年度口径计算。",
    kind: "feature"
  }, {
    title: "现金流编辑、预算追踪与分享视图按移动端参考图重做",
    desc: "收入和支出预估采用底部编辑页、彩虹金额输入、频率和支出类型选择；支出预算追踪支持排序；分享预览精简为图表、数据标签和保存图片，放大图下载按钮也可直接导出真实 PNG。",
    kind: "feature"
  }, {
    title: "修复简化版小屏金额溢出与表单挤压",
    desc: "修复全局 field 样式把添加/编辑投资资产、账户和汇总表单容器压成 44px 导致字段重叠的问题；补齐 320–500px 的窗口、金额、标题、列表和桑基图响应式规则，累计收益与超窄屏年度金额使用万单位。",
    kind: "fix"
  }, {
    title: "修复简化版刷新控件闪现与金额初值",
    desc: "页面准备完成前隐藏简化版窗口，避免刷新时右上角桌面控件闪现；更新收益金额默认留空，所有同类彩虹金额输入沿用完整记一笔的输入效果。",
    kind: "fix"
  }, {
    title: "加固简化版账本导入导出接口",
    desc: "Excel 导入和导出接口增加独立登录校验，不能绕过简化版页面直接调用；上传解析增加 10MB 文件上限，避免异常大文件占用服务资源。",
    kind: "security"
  }, {
    title: "简化版桌面端升级为宽屏财务工作台",
    desc: "手机端比例保持不变；桌面端首次升级自动迁移到约 1040px 的居中工作台，仍可自由拖动、缩放和固定。总览放大主资产卡和两张功能卡的内容尺度，二级现金流页面扩大有效内容区并统一桌面留白，解决宽屏下像缩小手机模拟器的问题。",
    kind: "feature"
  }, {
    title: "修复简化版刷新后窗口缩到左侧",
    desc: "窗口位置与尺寸现在同时记录保存时的浏览器视口；桌面、平板和手机尺寸发生变化后会按原中心位置重新换算并限制在可视区域，从小屏返回桌面时自动恢复约 1040px 的居中工作台，避免刷新后沿用旧绝对坐标而收缩到页面最左侧。",
    kind: "fix"
  }, {
    title: "打磨简化版投资详情手机布局与金额单位",
    desc: "资金加权收益率和年化收益率标题在普通手机保持紧凑排列，380px 以下自动改为两列布局，问号说明按钮不再受长标题挤压；账户及汇总的资产构成金额按数值自动使用万、亿、万亿单位并保留正负含义，避免完整大额数字溢出卡片。同步逐页检查投资列表、详情、汇总、添加资产、设置、家庭账本、更新资产、成员、月历、晴雨表和年度现金流的小屏显示。",
    kind: "fix"
  }, {
    title: "修复简化版外币投资账户详情误显示人民币",
    desc: "美元和港元投资账户详情改为始终使用账户原币：资产、累计收益曲线提示、资产构成、投入转出编辑、更新记录和复制摘要统一显示美元或港元，不再乘汇率后仍写成元；指标栏的累计收益省略重复币种并按万、亿等紧凑显示，三项指标在窄屏保持同一排，问号不再被挤压；投资汇总继续按人民币折算。",
    kind: "fix"
  }, {
    title: "打磨年度现金流概览操作布局",
    desc: "编辑入口移动到储蓄率右侧并与标题保持相同字号；支出预算追踪去掉多余的三点菜单，改为直接切换排序的图标按钮；桑基图右下角改为参考图中的圆形双折角放大按钮。",
    kind: "fix"
  }, {
    title: "家庭总资产变化示意图对齐参考逻辑",
    desc: "总览与家庭资产记账的总资产卡统一为三段状态示意：两侧使用紫色水平箭头，中间按资产差额显示红色上升、绿色下降或紫色持平，并保留右侧资产与负债各自按真实差额计算的变化结论；家庭页移除旧的五分类小柱图。成员筛选同步作用于资产合计、更新时间、趋势当前值和更新记录，成员视图不再误用全家历史快照；排除固定资产时，概览与放大桑基图也使用相同口径。资产组成金额统一采用万、亿等紧凑单位，避免手机端溢出。",
    kind: "fix"
  }, {
    title: "投资资产构成改为资金汇聚关系图",
    desc: "投资账户与投资汇总的资产构成按参考图重做为两层资金汇聚：投入、转出先汇入净投入，期初金额、净投入和收益再汇入期末金额；移除原有蓝色结果块，统一浅灰卡片、细曲线和圆角，仅用参考红色与绿色区分流入和转出。桌面保持完整留白，手机端同步缩短节点高度、字号与间距，金额继续使用万、亿等紧凑单位避免挤压。",
    kind: "fix"
  }]
};

export const V0_1_24_ENTRY: VersionEntry = {
  version: "v0.1.24",
  date: "2026-09-08",
  summary: "继续精修简化版交互、投资图表与发布状态体验。",
  frontend: V0_1_23_ENTRY.frontend,
  software: V0_1_23_ENTRY.software.map(item => item.name === "Fire" ? { ...item, version: "v0.1.24" } : item),
  changes: [{
    title: "资产构成汇聚曲线精确连接节点边框",
    desc: "按参考图重新校准投入、转出、期初金额、净投入、收益与期末金额之间的曲线：左右支线使用缓弧向中心收拢，汇合后保留短垂直主干，并精确停在下一层卡片的上下边框中心，解决期末金额连线被卡片遮挡、看起来没有连接的问题。",
    kind: "fix"
  }, {
    title: "资产构成时间范围可用并清理编辑弹窗异常文案",
    desc: "资产构成的记账以来、今年、近 1 年现在会按真实历史记录重算期初金额、区间投入、转出、净投入和收益；同时修复编辑累计投入、转出弹窗底部出现 undefined 的问题。",
    kind: "fix"
  }, {
    title: "累计收益曲线与当前累计收益保持一致",
    desc: "统一累计收益曲线和账户顶部累计收益的资金口径；手动修正累计投入或转出后，历史曲线会同步校准，末端金额与当前累计收益一致。",
    kind: "fix"
  }, {
    title: "曲线鼠标定位适配页面缩放与宽屏",
    desc: "收益率和累计收益曲线改用 SVG 实际屏幕变换矩阵计算鼠标命中位置，不再把两侧缩放留白误认为绘图区；悬浮提示按真实宽度自动翻转并限制在图表边界内，修复滑至末端时指针和 K 线明显偏离的问题。",
    kind: "fix"
  }, {
    title: "发布状态热力图改为连续周网格",
    desc: "deploy-status 热力图不再将 12 个月分别生成独立网格，而是将当年 1 月至 12 月从左到右按自然周连续排列；月份文字只标记所在周，跨月每日块与周统计保持连续，消除月份之间不规则的大段空隙。",
    kind: "fix"
  }, {
    title: "每日镜像避开整点调度延迟",
    desc: "GitHub Actions 改为香港时间每天 00:07 检查，避开整点调度高峰导致任务常延迟到凌晨 2 点以后；仅在 main 存在尚未发布的新提交时生成镜像，没有新提交会跳过重复构建。",
    kind: "fix"
  }, {
    title: "简化版手机端支持下拉刷新",
    desc: "在简化版页面顶部下拉并越过阈值后松开，可重新同步服务端账本和最新汇率，并显示下拉、松开、加载、成功或失败状态。刷新前先补写尚未同步的本地编辑，弹窗、输入控件、桑基图和全屏图表区域会阻止误触；汇率拉取完成后再统一重绘当前页面。",
    kind: "feature"
  }]
};

export const V0_1_25_ENTRY: VersionEntry = {
  version: "v0.1.25",
  date: "2026-09-09",
  summary: "时光机连接简化版与完整版。",
  frontend: [...V0_1_24_ENTRY.frontend, { name: "WebGL", version: "浏览器原生", desc: "哆啦A梦时光机原图纵深与局部视差动效" }],
  software: V0_1_24_ENTRY.software.map(item => item.name === "Fire" ? { ...item, version: "v0.1.25" } : item),
  changes: [{ title: "双向版本时光机", desc: "简化版工具栏与完整版页头新增版本穿越入口，点击即以用户提供的哆啦A梦时光机原图衔接页面切换，以 WebGL 对原图做柔和纵深与局部视差，保护人物区域，无额外流光或闪光，不支持 WebGL 时回退原图；支持深浅主题、手机小屏、减少动态效果，通过预取和应用内路由消除整页重载；隔离简化版样式并恢复返回后的窗口交互，离开前等待账本同步，失败时保留当前页面。", kind: "feature" }, { title: "版本穿越入口布局", desc: "简化版右上角直接显示无外框细线纸飞机，单击立即穿越；完整版入口保留在头像菜单，配合「去另一面」及目标版本说明。", kind: "fix" }, { title: "交易广场段永平刷新支持雪球登录 Cookie", desc: "雪球上线阿里云 WAF 反爬后，程序化拉取段永平发文被拦截，刷新拿不到新帖；为交易广场新增「雪球 Cookie」设置项，服务端改用登录会话请求，绕过 WAF 并正常获取新发文。", kind: "fix" }]
};

export const V0_1_26_ENTRY: VersionEntry = {
  version: "v0.1.26",
  date: "2026-09-10",
  summary: "修复刷新闪动，并新增全站市场色块设置。",
  frontend: V0_1_25_ENTRY.frontend,
  software: V0_1_25_ENTRY.software.map(item => item.name === "Fire" ? { ...item, version: "v0.1.26" } : item),
  changes: [{
    title: "修复资产分析刷新时左侧布局闪扩",
    desc: "刷新资产分析时左侧分栏会先扩大再收回。根因有两层：1) 分栏比例默认 29%，等 useEffect 读完 localStorage 才跳回保存值；2) CSS minmax(340px, 29%) 在容器宽度未定时把百分比当成内容上限，左栏先被图表/表格撑开。修复：<head> 同步脚本在首屏绘制前写入 fr 比例；组件首帧不写 inline 默认值；桌面分栏改用 fr，并给网格 width:100% + contain:inline-size，宽度只跟父级走。tsc 无错误。",
    kind: "fix"
  }, {
    title: "修复资产分析刷新闪现「加载中」",
    desc: "资产分析虽已 SSR，但仍用 next/dynamic 的 loading 组件；水合时异步块未就绪，整页会被 TabLoading「加载中…」盖住。改为随 RecordsApp 同步引入资产分析视图。趋势图缓存改为绘制前恢复，有缓存不再先显示「正在汇总真实历史行情…」，无缓存改为无文字骨架。tsc 无错误。",
    kind: "fix"
  }, {
    title: "全站排查并消除刷新闪「加载中」",
    desc: "后台所有页签不再用 next/dynamic 的 TabLoading：持仓、自选、FIRE、设置、全球预览、财报日历、名人持仓、交易广场、用户管理、素材库、附件、盈亏分析刷新时不再整页闪「加载中…」。登录表单去掉鉴权检查的加载中挡板（服务端已拦截已登录访问）。用户管理、全球市值榜绘制前恢复本地缓存；盈亏分析与财报日历的加载文案改为无文字骨架。tsc 无错误。",
    kind: "fix"
  }, {
    title: "设置-股票新增市场色块",
    desc: "全站市场徽标颜色与文字改为可配置：设置 → 股票设置 → 市场色块，可改美股/港股/上证/深证/加密及其他市场的底色、文字色与缩写；默认显示改用与站点信息「允许新用户注册」相同的开关，只读浏览也可直接拨动。保存后持仓、搜索、分享页、盈亏分析等处同步生效。股票来源接口移到股票类别末尾。tsc 无错误。",
    kind: "feature"
  }, {
    title: "默认券商分组与图标纳入干净素材",
    desc: "把已配置的九家券商（长桥、华泰、盈透、富途、同花顺、东方财富、老虎、罗宾汉、嘉信）写入默认设置，并与素材库 public/uploads/asset/broker 图标按名称/别名对应；新部署无需再手动添加券商，素材库券商图标随仓库同步。tsc 无错误。",
    kind: "feature"
  }, {
    title: "设置开关在只读浏览下也可拨动",
    desc: "站点信息「允许新用户注册」、市场色块「默认显示」以及定时备份开关统一为同一款绿色圆点开关；只读浏览时不再禁用，拨动后自动保存并弹出胶囊提示。tsc 无错误。",
    kind: "fix"
  }, {
    title: "设置页接入 Orca 设计语言",
    desc: "设置窗口按 Orca 的设置语言重排：默认中性灰色板、248px 分组侧栏、侧栏内搜索（⌘K）、大标题+说明与圆角内容卡片、左文案右控件的行语法；开关仍保留绿色圆点。原有风格切换（富途橙 / Notion / Claude 等）可继续换肤。tsc 无错误。",
    kind: "feature"
  }, {
    title: "修复市场色块设置触发 SWC 插件报错",
    desc: "服务端 settings 误引入带 React Hook 的市场色块模块，开发编译出现 Plugin is not supported with current @swc/core。已把 Hook 拆到独立客户端模块，服务端只引用纯函数。tsc 无错误。",
    kind: "fix"
  }, {
    title: "修复美股当日盈亏不更新（富途整批行情被 OTC 代码拖垮）",
    desc: "排查线上版美股当日盈亏整天不动、本地版正常：持仓 / 自选里的「软银（ADR）SFTBY」属于美股 OTC 市场，富途快照接口不支持它，而桥接脚本是整批一次请求 —— 一只不被支持就让整批 44 只美股全部拿不到富途行情。随后走腾讯兜底，但腾讯对美股只提供常规盘口径（盘前 / 盘后 / 夜盘仍停在上一交易日收盘的涨跌），当日盈亏就冻结在昨天；代码里本还有 Yahoo 扩展时段兜底，本机可用、线上容器取不到（同一接口线上连续 502）。量化：同一时刻线上口径合计 −941.63 USD（昨日常规盘涨跌），富途口径 −55.85 USD（今日盘前）。修复：scripts/futu_quotes.py 的批量快照改为容错 —— 整批失败时先剔除报错点名的代码重试，仍失败再二分定位，不支持的代码记入 skipped 由调用方继续走兜底源；实测含 SFTBY 的 45 只由「0 只返回」变为「44 只实盘 + 1 只跳过」，本机 /api/quotes 恢复 43 只 futu + 1 只 yahoo 盘前实时行情。tsc 无错误。",
    kind: "fix"
  }, {
    title: "恢复美股行情降级提示 + 空市场标签自动隐藏",
    desc: "1) 富途不可用退回腾讯时，我的持仓与资产分析的「账户资产」标题旁重新显示琥珀色「美股·腾讯兜底」胶囊（hover 说明盘前 / 盘后 / 夜盘的最新价与当日盈亏可能停在上一交易日收盘），行情正常时隐藏 —— 此前该提示组件在源码中缺失，降级时页面毫无迹象。2) 我的持仓市场标签改为「有持仓 / 本页添加记录才显示」：设置里的 markets 只负责顺序，空市场标签自动隐藏（与自选股空分组隐藏一致），日股等无记录市场不再出现「日股 0」；新增该市场记录后标签自动出现，当前停留的空市场自动回到总资产。tsc 无错误。",
    kind: "fix"
  }, {
    title: "美股行情兜底再加固（Yahoo 熔断 / OTC 单只隔离 / 空市场提示）",
    desc: "1) lib/usExtendedQuote.ts 新增 Yahoo 双主机熔断：出现服务级失败（连不上 / 403 限流 / 非 200）后 60 秒内直接判定不可用，不再逐只等超时 —— 含 44 只持仓的行情请求由 17.6 秒回落到 2.4 秒；只对服务级失败生效，单只标的在 Yahoo 查不到（200 无 result，如下市 / OTC）不触发熔断，避免一只坏标的关掉整批兜底（已用真实模块 + 打桩网络验证两种边界）。2) scripts/futu_quotes.py 的快照调用补异常容错：网络抖动 / SDK 抛错同样按「这批失败」处理，走剔除与二分重试。3) 我的持仓市场编辑面板对无记录市场标注「无记录 · 自动隐藏」，说明为何标签不显示。4) AGENTS.md 记录富途整批快照、美股扩展时段降级两条经验。tsc 无错误。",
    kind: "fix"
  }, {
    title: "全站 Review：修复交易广场 500 + FIRE 跨年口径不一致 + 冒烟补页面巡检",
    desc: "1) 交易广场整页 500：TradingSquareView 的 readSeen() 在 useState 初始化时读取 localStorage 且该行没被 try 包住，服务端渲染直接 ReferenceError，登录后访问 /trading 返回 500（本地 dev 与生产构建都复现，线上同源同版本受影响，2026-09-03 引入）。已改为显式判断浏览器环境；并用 TypeScript 编译器 API 扫过全部 JSX 确认没有 <button> 嵌套按钮，其余初始化期浏览器 API 均有保护。2) FIRE 跨年落账口径不一致：年末快照的「当前资产」用 currentAssets（不含手动覆盖），而上方面板 / 水球 / 今年这一行用 effCurUsd（含手动覆盖），跨年后冻结值会与页面显示对不上——统一为 effCurUsd 并补齐依赖项。3) 冒烟测试新增登录后页面巡检（16 个页面逐一检查 200），这台机器上旧的 82 项检查覆盖不到页面渲染，正是 /trading 500 漏网的原因；测试项 82 → 101。tsc 无错误、npm run build 通过、冒烟 101/101 全 PASS。",
    kind: "fix"
  }, {
    title: "台币接实时汇率 + 降级提示扩到自选股 + 冒烟补公开接口",
    desc: "1) 台币（TWD）过去只能一直用静态兜底汇率：汇率源富兰克福是 ECB 口径，不含台币（实测混在批量里被静默忽略、单独查 404），台湾市场换算偏差约 1–3%。现在 lib/rates.ts 对上游缺失的币种改用腾讯外汇补齐（whUSDTWD，与行情同主机、走设置里的 quoteApiUrl，无需 Referer、境内可直连），实测 TWD 由固定 0.031（≈32.3）变为实时 31.517；补齐失败仍回退上次成功值 / 静态兜底，不影响主流程。2) 行情降级提示判定放宽并接入自选股：有持仓的美股降级必报，只看自选股时至少两只走腾讯兜底才报（富途本就不提供美股 OTC 行情，单只 OTC 不再误报）。3) 冒烟测试补 9 项公开接口检查（交易广场 feed / 段永平 / 特朗普、行情、美股五日分时、个股详情、汇率含台币），测试项 101 → 110。4) 删除已被 app/api-docs/page.tsx 取代的 components/views/ApiDocsView.tsx（179 行死代码）。tsc 无错误、冒烟 110/110 全 PASS。",
    kind: "feature"
  }, {
    title: "修复出站代理一直失效（undici 与 Node fetch 不匹配）+ 全部 Yahoo 请求接入代理",
    desc: "排查「配了 STOCKLOG_PROXY 线上仍取不到 Yahoo 扩展行情」：lib/net.ts 用 Node 自带的全局 fetch 承载 npm 安装的 undici ProxyAgent，两者不是同一份实现，请求必定抛 `invalid onRequestStart method (UND_ERR_INVALID_ARG)` 并被 catch 静默回退直连——所以代理看起来「开着」，其实从未生效。修复：代理分支改用 undici 包自己的 fetch（`import { fetch as undiciFetch } from \"undici\"`）与 ProxyAgent 配套，未启用代理或代理失败仍回退全局 fetch 直连。同时把仍走裸 fetch 的 Yahoo 调用全部接入 proxyFetch：lib/usExtendedQuote.ts（盘前 / 盘后 / 夜盘报价）、lib/quotes.ts（美股分时迷你图）、lib/kline.ts（美股日 K）、/api/kline/five-day、/api/kline/session-day、/api/v1/index-kline；境内源（腾讯 / 新浪 / 东财）保持直连。实测：带代理启动的隔离实例上 /api/kline/session-day 由 502 变为 200 并返回盘前点（AAPL 04:00 起），未经代理时仍直连不受影响；线上群晖 .env 的 STOCKLOG_PROXY 已由 off 改为 http://192.168.28.55:1088（下次重建容器生效）。AGENTS.md 记录该坑。tsc 无错误、构建通过。",
    kind: "fix"
  }, {
    title: "代理加 no_proxy 保护：内网地址永不发往代理",
    desc: "按「防止本地 / 内网地址被交给代理」的要求在 proxyFetch 里补 no_proxy 判定：命中「内置私网（10/8、172.16-31、192.168/16、127/8、169.254/16、100.64/10、.local / .lan / .internal / localhost / IPv6 回环与 ULA）」或 NO_PROXY / no_proxy 环境变量（支持 `*`、域名后缀、IPv4 与 IPv4/掩码）时直接直连，不看代理是否可用；这样富途 OpenD、NAS 接口、体检探针等内网请求不会泄露给第三方代理。另加 STOCKLOG_PROXY_DEBUG=1 开关，按请求打印「走代理 / 直连（内网 / NO_PROXY）/ 代理失败回退直连」，代理问题不再需要猜。实测：带代理时 127.0.0.1 与 192.168.28.5 判定直连、Yahoo 走代理返回 200。注意 Node 的 fetch 不读容器里的 http_proxy / https_proxy / no_proxy（那是给 curl / python / npm 的），因此本应用只认 STOCKLOG_PROXY + 这套 no_proxy 规则。tsc 无错误。",
    kind: "security"
  }, {
    title: "日韩实时行情 + OpenD 本地让路 + 行情提示补齐",
    desc: "1) 自选股 / 持仓行情接口补上腾讯日股 jp{} / 韩股 kr{}，分时与搜索联想同步；台股 / 新加坡 / 欧澳加印巴等无源市场行内标明「暂不支持实时行情」。2) 本地 next dev 默认不连 OpenD（STOCKLOG_FUTU=on 可开），线上生产继续用唯一连接。3) 富途正常时单只 OTC 在 Web 行内与 iOS 列表显示「无扩展行情」，整批降级仍用「美股·腾讯兜底」。4) Yahoo 扩展行情可用 STOCKLOG_EXTENDED_QUOTE=off 关掉。5) 仓库只保留 docker-compose.ghcr.yml，审计不再读已删除的本地 compose。6) CI build 后跑公开短冒烟（含日韩现价），并提供 .githooks/pre-push。tsc 无错误。",
    kind: "fix"
  }, {
    title: "打磨行情提示位置与整批降级判定",
    desc: "行内「暂无实时行情 / 无扩展行情」收到股票代码同一行，资产分析持仓表与盈亏排行同步显示；整批「美股·腾讯兜底」把 Yahoo 扩展行情也视为在线，避免本地跳过 OpenD 后单只 OTC 误报整批降级。设置页补充 OpenD 本地跳过说明；东财搜索联想覆盖日股 / 韩股。tsc 无错误。",
    kind: "fix"
  }]
};

export const V0_1_27_ENTRY: VersionEntry = {
  version: "v0.1.27",
  date: "2026-09-11",
  summary: "修复金额「水合不一致」：汇率等本地缓存改为挂载后读取，服务端与客户端首帧数字一致。",
  frontend: V0_1_26_ENTRY.frontend,
  software: V0_1_26_ENTRY.software.map(item => item.name === "Fire" ? { ...item, version: "v0.1.27" } : item),
  changes: [{
    title: "修复金额「水合不一致」（首帧读本地汇率缓存导致 SSR 与客户端两份金额）",
    desc: "现象：资产分析页 / 我的持仓页刷新后 dev 弹 hydration 报错，持仓总市值、现金等服务端渲染 51,392.88、客户端首帧 52,546.83（差 2.2%）。根因：AssetAnalysisView.tsx 与 HoldingsView.tsx 的汇率 state 用 useState 初始化函数直接读 localStorage 的 fire:rates —— 服务端读不到、只能用 FALLBACK_RATES，客户端首帧读到实时汇率，跨币种金额必然不同；React 水合只比对首帧渲染，所以这颗雷一直在，只是金额每次都「差一点点」时才会弹。同类写法还有：持仓页的 ratesReady 与各市场盈利卡片顺序、盈亏分析页的日历市场 / 基准 / 加权 / 日历月份四个本地偏好、全球预览页的迷你 K 线缓存。修复：新增 lib/ratesCache.ts 统一读写汇率缓存（注释写明只能挂载后读）；上述所有读取改为「首帧用默认值 + useLayoutEffect 恢复」——useLayoutEffect 先于 paint，既不会水合报错，也看不到兜底值闪烁（原本为防闪烁才首帧读，方向对、位置错）。tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "修复交易广场段永平不更新（雪球时间线接口过时）",
    desc: "加了雪球登录 Cookie 后段永平仍停在 9 月 2 日。根因不是 Cookie 没带上，而是抓取走了 `/v4/statuses/user_timeline.json?type=0`：xueqiu.com 被 WAF 返回 HTML 挑战页，api.xueqiu.com 的 v4+type=0 只给较早的原创帖，新回复/转发不会出现，刷新却被当成成功并写回旧缓存。改为优先请求 api.xueqiu.com 的 `/statuses/user_timeline.json`（完整时间线，实测含 9 月 10 日新帖），拉长超时、按数字判断 error_code（避免字符串 \"0\" 被当成失败）。设置保存雪球 Cookie 时忽略空串和 ********，防止 GET 脱敏把已保存会话覆盖掉。tsc 无错误。",
    kind: "fix"
  }, {
    title: "修复交易广场页水合报错（段永平全量时间线撑爆 feed）",
    desc: "雪球完整时间线修好后段永平缓存从约 200 条涨到 700+ 条，/api/trading-square/feed 约 700KB+。交易广场首帧从 localStorage 读这份缓存，服务端只能渲空列表，React 19 水合对不上整页报错；4 秒超时也容易把大包打断。修复：首帧用空列表对齐 SSR，缓存和 URL 筛选在 useLayoutEffect 恢复；拉接口超时改为 12 秒；列表按作者各取最近 200 条，磁盘仍保留完整历史供翻页重叠。tsc 无错误。",
    kind: "fix"
  }, {
    title: "修复刷新时闪现市场色块（设置里已关闭仍会闪一下）",
    desc: "现象：设置 → 股票设置 → 市场色块「默认显示」关掉后，刷新任意页面仍会先冒出几块市场色块再消失。根因：色块读的是 lib/marketBadge.ts 的模块级 store，初始值固定为「显示 + 默认配色」，而服务端设置只在 RecordsApp 的 useLayoutEffect 里应用 —— effect 只在水合之后跑，所以服务端渲染出的 HTML 里本来就有色块，浏览器先画出这版 HTML，等水合隐藏。修复：新增 primeMarketBadges()（渲染期写入模块状态、不通知订阅者，避免打断水合；值没变时空操作），RecordsApp 在渲染一开始就按服务端设置初始化，服务端与客户端首帧一致；applyMarketBadges() 改为仅在值变化时通知。附带收益：自定义配色的闪动也一并消失（同一机制）。验证：同一账号（色块关闭）对 /holdings 的服务端 HTML 做前后对比 —— 修复前含 1 处色块（色块专用 class + style 默认蓝 #3b82f6），修复后 0 处，其余内容一致；Node 里直接验证 store 初始（visible=true / US #3b82f6）与 prime 后（visible=false / 自定义色）。tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "修复顶部指数栏 mini 趋势取错价格（取每分钟开盘 → 改成收盘）",
    desc: "现象：顶部指数栏的迷你趋势线尾部与旁边的现价对不上（如恒指线尾 24956.94 而现价 24954.47）。根因：lib/ticker.ts 解析东财分时数据时取了第 2 列（每分钟开盘价），应取第 3 列（每分钟收盘价）。量化比对（恒生指数 2026-09-10，东财 331 根 vs 富途 1 分钟 K 线 331 根）：开盘口径平均差 4.74 点、最大差 65.60 点、仅 1 根完全一致；收盘口径 331/331 完全一致（误差 0.00）。修复后 mini 趋势与券商（富途）分时逐分钟相同。顺带记录：富途里恒指代码是 HK.800000（不是 HK.HSI，应用的 _to_futu_code 会把 HSI 补成 00HSI 而查不到），以后接富途指数行情需注意。tsc 无错误。",
    kind: "fix"
  }, {
    title: "交易广场贴文可读性：解码实体、@高亮、长文折叠、原图",
    desc: "段永平长回复里会露出 `&#34;`、`**加粗**`、行首 `*`；引用里的 @用户名没有高亮；Gemini 长文把一屏撑满；8 月 31 日 13:24 泡泡玛特配图被存成雪球 `!thumb.jpg`（60×80，约 3KB），原文是 2048×2731。修复：展示与落盘前解码 HTML 实体并去掉轻量 markdown；@提及用雪球蓝字高亮并链到主页（此前只用了和正文几乎同色的 brand-deep，看起来像没高亮）；正文默认 5 行、引用 4 行，超出显示「展开」；下载配图时去掉 `!thumb` / `!custom` 后缀取原图，已存的缩略图下次刷新会重拉。tsc 无错误。",
    kind: "fix"
  }, {
    title: "交易广场股票名按涨跌着色（涨红绿跌虚线）",
    desc: "贴文里的股票名虚线原先固定灰色。改为挂载时拉行情：涨（changePct≥0）红色虚线，跌绿色虚线，字体颜色不变；行情未返回前虚线仍用灰色。同一代码多处出现只请求一次。tsc 无错误。",
    kind: "fix"
  }, {
    title: "交易广场股票卡片显示开盘中 / 未开盘 / 休市",
    desc: "鼠标划过贴文里的股票名，行情卡片恢复原排版：名称+市场色块、代码旁灰色时段（盘前交易 / 盘中交易 / 盘后交易 / 夜盘交易，周末休市）、现价涨跌、昨收与市值、行情时间；去掉「点击查看详情」。行情未返回时不再写「正在获取行情…」，改为无文字骨架。tsc 无错误。",
    kind: "fix"
  }, {
    title: "个股详情补素材库图标（不在持仓里的股票也能显示）",
    desc: "素材库有泡泡玛特（HK:09992）图标，但从交易广场打开个股详情只预热了持仓/自选图标，未持仓标就变成首字母。改为按市场+代码单独查素材库，港股 9992 / 09992 都能对上，不拉 3000+ 全量。tsc 无错误。",
    kind: "fix"
  }, {
    title: "手机端财报日历日期格显示股票图标",
    desc: "手机端财报日历格子宽高不变。小屏日期靠左、右侧两排圆形图标+名称（过长省略），超过两家格内上下滑；较大手机仍是日期在上、两排公司。tsc 无错误。",
    kind: "fix"
  }, {
    title: "指数栏轮询改自适应：开市 60 秒、全部收市 5 分钟兜底",
    desc: "原来指数栏固定每 60 秒轮询一次，全收市时段也在刷。改成按市场状态自适应，且不维护开市时间表（夏令时 / 节假日 / 半天市 / 交易所改时间都不用跟）——让数据自证：服务端记下上一轮各指数的「最后一根分时时间 + 点数」，有任何一项前进就返回 pollSec=60，全部不动则返回 300；客户端按返回的间隔轮询，同时保留「页面重新可见立刻刷新」和「后台暂停」。踩过的坑：最初想按「分时时间 vs 市场本地时间」判断开市，实测东财给美股的时间戳是北京时间（道指末行 03:34 对应当地 15:34），按时区算会把开市误判成收市（pollSec 错误地变成 300），改成比上一轮增量后完全不依赖时区。验证：单元层面 5 组用例（首次拉取 / 有新数据 / 完全不动 / 新增指数 / 空列表）全部符合预期；实测美股开市期间间隔 62 秒取两次均返回 60 秒，点数 357 → 367 在增长。tsc 无错误。",
    kind: "fix"
  }, {
    title: "指数栏：东财为主 + 收盘后与富途低频对账；轮询退避补到周末档",
    desc: "数据源定案：指数栏继续以东方财富为准（覆盖全部指数、无连接与额度约束、实测 0.17~0.21 秒），富途只做低频校对 —— 实测富途 OpenAPI 只支持恒指 HK.800000、恒生科技 HK.800700、上证 SH.000001、深证 SZ.399001、日经 JP..N225；美股指数接口明确「暂不支持」、新加坡指数无权限、韩国市场 OpenAPI 根本没有（这些品种 App 有、接口不给，所以不能作为首选源）。对账实现：每个交易日、每个指数收盘 10 分钟后（当日分时已定型，开市时两边延迟不同会误报）拉一次富途 1 分钟收盘序列，与东财逐根按当日第 N 根对齐比（不按时间戳，避免时区差异），错位超过 20% 根数判为口径漂移并打 warn；结果写入 /api/ticker 与 /api/health 的 tickerCrossCheck。实测：收盘口径（现状）0 根不一致、不误报；把字段换回开盘口径（修复前的 bug）则 299/331 根不一致、最大差 65.6 点，能被准确抓住。轮询退避补齐到四档：开市 60 秒 → 刚收市 5 分钟 → 隔夜 15 分钟 → 跨夜/周末/长假 30 分钟；并修掉「上游全部取不到时被误判成收市」的漏洞（取不到一律保持 60 秒尽快恢复）。scripts/futu_quotes.py 的代码映射补上 SH / SZ / JP（原来只认 US / HK / CN）。tsc 无错误。",
    kind: "feature"
  }, {
    title: "修复交易广场刷新把发文弄没（合并改为并集，不再以服务端返回为准）",
    desc: "现象：交易广场刷新后列表变空，只剩骨架屏和「0 条」，左侧「全部动态」显示「— 条」。根因：客户端合并函数 mergeFeedPosts 是「以服务端本次返回为准」——只遍历 incoming，本地有而本次没返回的帖子直接消失；而服务端列表是会变短的（某位作者这次没抓到、源站分页变短、或新帖还没翻译被过滤），更糟的是缩水后的结果会被写回 localStorage 缓存，等于连本地缓存一起清空，于是刷新一次就整片没了、之后也恢复不了（要等服务端重新抓到）。修复：合并改成并集 —— 新数据照旧覆盖并回填译文与本地图片，同时保留「本地有、本次没返回」的帖子，顺序与条数仍由 takeNewestByAuthor 按作者截取最新 200 条，不会无限增长。边界：真被源站删除的帖子会在本地多留一段时间，随 200 条上限自然淘汰。另外把缓存写入失败改成 console.warn（配额满 / 无痕模式时能看出是缓存没写成，而不是以为帖子丢了）。验证：tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "交易广场：刷新时静默等待（去掉「尚未同步 / 0 条」），拖动位置首屏就位不再跳",
    desc: "两处体验问题一起修：1) 刷新时页面会显示「尚未同步」「0 条」「— 条」这类文字，看上去像发文被清空了 —— 现在加载完成前这些位置一律留空，只保留静默的占位骨架，感觉就是在原处等内容出现；有数据后才显示条数与更新时间（顺带把「尚未同步」这个文案彻底去掉）。2) 拖动过交易广场窗口后，刷新会先画在默认位置再跳到保存位置 —— 根因是位置由 useDraggableWindow 的 useEffect（绘制之后）恢复，而迁移到 CSS 变量（--trading-x / --trading-y）后可以用首屏同步脚本：在 app/layout.tsx 的 head 脚本里读 fire:trading-square-window-pos，绘制前写进 :root；组件只在已知非零位置时才用 inline 覆盖，并给 var() 加 0px 兜底。附带修掉之前那版合并的副作用：服务端列表变短时不再丢帖子（并集 + 每位作者 200 条封顶）。验证：tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "设置-站点信息改为常驻可编辑 + 自动保存（去掉「编辑 / 保存」两个重复按钮）",
    desc: "按主流做法（macOS 系统设置、Linear、Vercel 的自动保存）收掉重复操作：站点信息不再分「只读浏览 / 正在编辑」两态，字段常驻可编辑，改动仍由已有的全局自动保存落库（700ms 防抖 + 胶囊提示，失败变红）；因此去掉分区里的「编辑」铅笔与「保存」按钮，标题栏的铅笔/✓ 在这个分区也隐藏（其余分区仍需要它做完提交）。头部状态文字在该分区显示「修改自动保存」。验证：tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "feature"
  }, {
    title: "设置分区折叠：日常三块默认展开并记住收起，点「编辑」自动展开",
    desc: "设置已按侧栏拆成独立条目，但首页指数设置 / 首页导航 / 应用导航菜单仍是「默认收起」，每次进来都要手点一次。改为默认展开，并保留「手动收起后记住」的行为（storageKey 升到 v2，让新默认对老用户也生效）；股票来源接口字段多且低频，保持默认收起但同样记住展开。另外补一个通用补丁：SettingsSection 新增 reveal —— 点分区里的「编辑」时自动展开，避免对着收起的分区进入编辑态却看不到任何内容（四个分区都接上了）。验证：tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "feature"
  }, {
    title: "设置：标题栏铅笔只负责进入编辑，保存只留分区里那一颗",
    desc: "现象：进入编辑态后标题栏的 ✓ 和分区头部的「保存」都能提交，两个都像保存按钮，容易点错也容易困惑。改为：标题栏那颗图标永远是铅笔（只表示「进入编辑」，不再变成 ✓），编辑中它高亮成蓝色且禁用，鼠标悬停提示「正在编辑，改完点分区里的『保存』」；全站唯一的保存入口就是分区头部那颗「保存」。站点信息是常驻可编辑 + 自动保存，本来就不需要这个入口，标题栏对它继续隐藏。验证：tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "交易广场口径定案：不设上限，保持现有内容 + 往后追加新帖",
    desc: "沟通过程中来回调了三次口径，最终定案：动态以「现有内容 + 往后持续追加新帖」为准 —— 不设时间窗（不做「只留最近一个月」）、不截断历史（作者上限设为不截断）、也不往回抓历史；段永平与特朗普一视同仁。客户端首屏缓存仍单独收敛：每位作者最多缓存 400 条 + 2.5MB 上限，超限跳过写入并 console.warn（列表展示不受影响，只是下次刷新先走骨架）。实测接口返回 491 条（特朗普 291 + 段永平 200），最早 2026-07-19、最新 2026-09-10，日期与排序正常。tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "feature"
  }, {
    title: "交易广场首屏缓存加保护（列表不限条数，缓存单独收敛）",
    desc: "取消接口上限后历史会一直增长，客户端 localStorage 缓存有写爆风险（写失败会导致下次刷新先看到加载态）。优化：缓存层单独限制为每位作者最近 400 条，并加 2.5MB 体积上限——超限则本次跳过写入并 console.warn，列表展示不受影响（列表本身仍是全部历史）。tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "feature"
  }, {
    title: "交易广场取消每位作者 200 条上限（接口返回全部历史）",
    desc: "此前列表接口每位作者最多返回 200 条（1faf84f 为修水合崩溃加的），没在界面上说明，用户不知情。按要求取消限制：TRADING_SQUARE_AUTHOR_LIMIT 设为不截断，接口改为返回全部历史；同时给 takeNewestByAuthor 补上显式时间倒序（原先只有截断时才会排序，取消上限后必须自己排，否则本地并集合并会把旧帖追加到末尾打乱顺序）。实测接口由 400 条变为 491 条（特朗普 291 + 段永平 200；段永平的 200 是上游/磁盘缓存本身的条数，不是展示限制）。无上限后 payload 与客户端 localStorage 缓存会随历史增长，将来若出现缓存写入失败，可在客户端缓存这一层单独截断。tsc 无错误。",
    kind: "feature"
  }, {
    title: "修好货币首屏：cookie 常量在布局里拿不到，改用字面量后 SSR 直接渲染所选货币",
    desc: "上一版把货币偏好写进 cookie 并由布局注入，但实测无效：布局里从 @/lib/currencyPrefs 导入的 DISPLAY_CURRENCY_COOKIE 在服务端渲染时为 undefined，于是 `startsWith(undefined + 等号)` 永远匹配不到，cookie 读出来是空的（用调试标记逐层验证：原始 Cookie 头里确实有 fire-display-currency=CNY，但解析结果为空）。改为在布局里用字面量常量名后立即生效：带 fire-display-currency=CNY 请求 /global，服务端输出 显示货币：人民币 + flag/cn.svg（不带 cookie 时仍是美元）。至此货币刷新不再闪默认值；老用户第一次加载会由客户端补写一次 cookie，之后不再闪。验证：tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "修复刷新时闪现默认货币（货币偏好写入 cookie，服务端首屏就是所选货币）",
    desc: "现象：选了港元 / 人民币等展示货币，刷新时先闪一下美元（列表里第一个）再切回来。根因：货币走 localStorage + usePersistedState，设计上「服务端与客户端首帧一律用默认值、挂载后恢复」，所以首屏 HTML 里根本没有用户偏好 —— 浏览器先画出美元那版，水合后才切换（全站 13 个文件用这个 hook，所以是全局现象）。修复：偏好同时写一份 cookie（fire-display-currency，一年有效、samesite=lax），服务端布局读 cookie 并通过新的 CurrencyProvider 注入，useDisplayCurrency 的首帧值优先用它 —— 服务端和客户端首帧都是所选货币，刷新零闪；切换货币时自动写 cookie，老用户没有 cookie 仍按默认美元。已接入 /[…slug]（我的持仓、资产分析、盈亏分析等）与门户首页。验证：tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "设置：编辑态补上「取消」（回滚到上次保存并退出编辑）",
    desc: "原来编辑态只有「保存」，没有后悔药 —— 主流做法（GitHub / Stripe 行内编辑、iOS 编辑页）都是「取消 + 保存」成对出现。做法：新增 lastSavedRef 记录「上次保存成功」的完整设置深拷贝（含 tabs 等独立状态，tabsRef 同步避免闭包取旧值），编辑态的分区头部在「保存」左边渲染一个次要的「取消」；点取消即回滚 site + tabs、重新对齐自动保存基线（避免回滚本身触发自动保存）、退出编辑态并提示「已取消未保存的修改」。覆盖首页指数、首页导航、应用导航菜单、网站形象、股票来源接口、翻译服务、交易广场、数据库等所有编辑态分区。验证：tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "feature"
  }, {
    title: "首页导航的显示/隐藏改成眼睛图标（右对齐同一列）",
    desc: "原来的「勾选框 + 显示」占一行且语义绕（勾上=显示），改为眼睛图标按钮：显示态睁眼、隐藏态闭眼（带斜线），鼠标悬停有提示「已显示，点击隐藏 / 已隐藏，点击显示」，无障碍属性用 aria-pressed。按钮固定 28px 宽、靠右对齐，和左侧拖拽手柄分列两端，多行之间自然对齐。验证：tsc 无错误、npm run build 通过、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "手机端财报日历改为与桌面完全一致（同一套格子与悬浮卡片）",
    desc: "手机端财报日历改成与桌面完全一致：格子尺寸、内边距、圆角、列间距、日期字号与「3 家 + 「+N 家」」的截断逻辑全部沿用桌面同一套（删掉移动样式表里针对财报日历的 46px 小格子、隐藏公司行、隐藏悬浮卡片、隐藏「+N 家」等所有手机专属覆盖），点日期弹出的公司卡片也与桌面同一套（同一个格内悬浮卡片、列表内部滚动）。这样手机和桌面看到的是同一个组件、同一套交互，不再有两套样式。",
    kind: "fix"
  }, {
    title: "修复财报日历日期详情星期错一位（9 月 11 日显示成「周六」）",
    desc: "现象：点开日期（或自动展开今天）后，详情头部的星期与日历列对不上 —— 2026-09-11 的格子就在「周五」列，头部却写「周六」。根因：`WEEKDAY_ZH` 数组是「周一…周日」的口径，而 `new Date(...).getDay()` 是「周日=0…周六=6」，直接拿它当下标等于整体错一位（周五 getDay()=5 → 查表拿到周六）。修复：新增 `weekdayZh(y, m, d)` 助手统一做 `(getDay()+6)%7` 换算（与日历网格首列算法同源），并加注释写明两种下标口径，避免再按错。",
    kind: "fix"
  }, {
    title: "全站排查同类「日期错一天」：资金记一笔默认日期 / 日期上限 / 分享图与导出文件名不再用 UTC 日期",
    desc: "以财报日历为起点把全站日期写法过了一遍：`getDay()` 共 11 处，除财报日历那一处外其余口径都正确（4 个日历组件的「周首日」算法、个股 K 线的星期文案、周 K 聚合），`星期X` 文案只有个股 K 线一处且正确。查出同类的第二类写法 —— 用 `new Date().toISOString().slice(0, 10)` 取「今天」：它按 UTC 算，东八区 00:00-08:00 会得到昨天。受影响：1) 资金「记一笔」的默认发生日期与日期选择器上限（该时段选不了今天、「回到今天」也会回到昨天）；2) 当日盈亏 / 盈亏总额 / 持仓盈利图分享图与订单导出的文件名日期。新增 `lib/format.ts` 的 `localDateKey()`（本地日历日期）替换这 6 处；周 K / 财报 / 行情区间里的 toISOString 保持原样（那些是按 UTC 日期串对齐数据源，属于正确写法）。tsc 无错误。",
    kind: "fix"
  }, {
    title: "财报日历头部收口：「实时」换绿点、无数据市场收进「更多」、「共 N 家」归位",
    desc: "三处调整：1) 「实时」胶囊前的小圆点由中性灰改成苹果绿（#34c759，与全站开关同色），实时状态一眼可辨；2) 市场筛选常驻只留真有财报数据源的美股 / A 股，港股 / 日股 / 韩股收进「更多」（chevron 展开 / 收起，避免常驻几个点进去只看到「数据源暂未接入」的死入口），展开时三个市场插在 A 股之后、「更多」始终排在最后一位，当前选中的市场始终保留在常驻位、不会因收起而「隐身」，拖动排序索引仍按完整市场顺序计算；3) 「共 N 家」从标题行最右侧（与左侧月份导航隔着一大片空白，看着散）移到「实时」右边，与月份导航 / 回到本月 / 实时组成一组状态胶囊，数字仍与筛选后的家数同源。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "财报日历当天明细改紧凑表格（列头对齐、分隔线，收掉中段大空白）",
    desc: "现象：点开某天的公司明细一行一张独立卡片，时段 / EPS / 现价三块飘在行中段，右侧还空着一整列 —— 根因是桌面网格写了 5 列（`1.8fr auto 1fr 1.2fr 1fr`）却只有 4 个内容块，现价落在第 4 列，最后一列永远是空白。改为与素材库同一套表格写法：外层一个圆角容器 + 列头（公司 / 时段 / EPS 预期（A 股为报告期）/ 现价），数据列固定 88 / 132 / 150px 与列头严格对齐，公司列吃剩余宽度，行高 py-3 → py-2、去掉卡片阴影与悬浮位移，改用分隔线 + 行悬停底色，同一列的数字纵向对齐成列。手机端维持原来的三列（公司 / 时段 / 现价），继续走移动样式表的覆盖；当天被筛选隐藏时不再渲染一个空的表头框。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "财报日历当天明细：市值单独成列 + 后四列固定窄宽紧排，明细区收成紧凑卡片",
    desc: "表格化之后还剩两个问题：公司列吃掉所有剩余宽度（约 60%），市值 / 时段 / EPS / 现价被推到最右边并平均分摊，列与列之间仍有十几到二十几个百分点的空档，整体还是显空。这一版：1) 市值从公司名下方那行拆出来，在 lg（≥1024px）起单独成列放在公司右边；2) 四个数据列全部改成固定窄宽（市值 96 / 时段 80 / EPS 112 / 现价 112）并紧挨着排（列间距 16px），公司列只占剩余宽度（约 350px），列的位置不再随屏幕拉伸；3) 明细区（日期 + 表头 + 行）最大宽度收到 880px，右侧那块空白从「表格内部的列与列之间」挪到「表格外面」，不再把列撑开。md（768-1023px）保持四列（无市值列），市值继续跟在代码后面；手机端仍是三列。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "财报日历时段圆点重新配色：盘前琥珀 / 盘中蓝 / 盘后紫",
    desc: "原来三个圆点是盘前琥珀 #e6a23c、盘后中性灰 brand、盘中浅灰 #9aa1ab —— 盘后与盘中两个点肉眼几乎分不出来，「盘前 / 盘中 / 盘后」等于只有两种颜色。按「一天的时间线」重配：盘前琥珀 #e6a23c（开盘前）、盘中蓝 #3297f6（交易中，沿用全站日历选中态的蓝）、盘后紫 #8b5cf6（收盘后），三个色相互相拉开；同时刻意避开涨红 #e23d3d 与跌绿 #0fa07b，避免小圆点被误读成涨跌方向。未识别时段仍用中性灰 #9aa1ab。三个色在浅色单元格（#f7f8fa）与深色单元格（#0f1319）上都够醒目，深浅色共用同一组。tsc 无错误。",
    kind: "fix"
  }, {
    title: "财报日历时段配色全站统一：明细胶囊、筛选标签、筛选小圆点都跟随圆点颜色",
    desc: "圆点换色后，明细表里的「盘前 / 盘中 / 盘后」胶囊文字还是原来的琥珀 + 两种灰，筛选区那排「全部 / 盘前 / 盘后 / 盘中」也全是中性灰，跟圆点对不上。这一版全部对齐到同一份配色（`TIME_DOT` 为单一来源）：1) 明细胶囊改成同色系浅底 + 同色系深色文字（盘前 #fff4e5/#b06a00、盘中 #e9f3fe/#1b6fc9、盘后 #f2ecfd/#6a41d6），深色模式在 globals.css 补覆盖（#10202f、#1f1836 底，文字 #6fb4f7、#b79bf8；琥珀沿用已有的 #2b2413/#e6b45c）；2) 时段筛选的每个标签前面补一个对应颜色的小圆点（全部为中性灰），文字也用同色系颜色，选中的那颗用 `!` 覆盖 `.seg-active` 的文字色以免被中性色顶掉，深色模式换成提亮版。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "财报日历当天明细区改回满宽，右边缘与上方日历网格对齐",
    desc: "上一轮为了收紧列距给明细区加了 880px 宽度上限，在约 968px 视口下它的右边缘比上方日历网格短约 30px（表格短约 32px），看着像没对齐。这一版去掉宽度上限，明细区（日期 + 表头 + 行）铺满卡片内容宽度、与日历网格左右对齐；同时把公司列从「吃满剩余宽度」改成封顶 420px，数据列继续固定窄宽紧挨着排，所以去掉上限也不会把四列重新拉开——公司列 + 四个数据列合计约 884px，右边缘对齐的同时列仍是紧排的。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "财报日历当天明细表贴边：表格边框与上方日期卡落在同一条竖线上",
    desc: "上一版放开宽度后，明细区的外框与日历网格对齐了，但表格本身还套在一层带内边距的面板里（面板 mx-5 + p-4），左右各再缩进 16px，所以跟上方日期卡片的边框仍差一条线。这一版把明细面板合并成整块：面板不再留内边距，日期标题与提示单独用 px-3/px-4 排版，表格（列头 + 数据行）改为通栏贴边、去掉自己的圆角与左右边框，由面板外框统一收边——上下两块的外框因此落在同一条竖直线上；日期标题与表格之间用一条分隔线过渡，底部圆角由面板的 overflow-hidden 裁切。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "A 股 9 月没有财报：查明是上游预约披露的空档月，界面补上解释",
    desc: "现象：A 股切到 9 月显示「该月暂无财报数据」、共 0 家。排查：直接按 `FIRST_APPOINT_DATE` 查东方财富预约披露接口，上游对 9 月回 `code 9201 返回数据为空`；对照查 8 月（有数据）、4 月（有数据）、去年同期 10 月（有数据）、今年 10 月（上游同样为空，因为三季报预约披露日期还没到发布时点）——A 股半年报集中在 7-8 月、三季报预约披露要到临近 10 月才发布，9 月天然是空档，接口本身正常。修复：空月份不再只显示一句「暂无数据」，改成说明空档原因并给一个「查看上月（8 月）」的入口；空月份缓存 TTL 由 12 小时缩到 30 分钟，新财报季一发布预约日期就能很快显示出来。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "财报数据不再被「空响应」清空：每月保留最后一次成功抓取的快照",
    desc: "把数据留在本地，防止上游失败 / 返回空时把整月清成全空：1) 缓存记录拆成 `items/at`（最后一次真正拿到数据的内容与时间，`updatedAt` 用它展示）与 `checkedAt/ttl`（上次问上游的时间与有效期）；这一轮上游返回空时只更新 `checkedAt`、磁盘上那份好数据不覆盖，接口继续返回上次抓到的财报（30 分钟后再问一次），进程重启后也能直接读到；2) 抓取结构异常（HTML 挑战页 / 风控 / 字段改名）不再静默当成「这天没有财报」，改为抛错走失败分支，避免把空结果写进缓存，美股逐日失败也不会被当成「整月无财报」；3) 前端 localStorage 同理——服务端这轮返回空而本地已有当月数据时，保留本地那份、不覆盖也不写空缓存。演练验证：把 8 月的 127 家快照伪装成「已过期」放到 CN:2026-10 目录，请求接口先返回这 127 家（updatedAt 为快照时间），触发上游刷新（上游对 10 月回空）后磁盘文件仍是 127 家、未被清空；随后清理演练数据，A 股 10 月回到真实的空状态并写入 30 分钟 TTL。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "fix"
  }]
};

export const V0_1_28_ENTRY: VersionEntry = {
  version: "v0.1.28",
  date: "2026-09-12",
  summary: "财报日历接入港股：数据取自雪球财报日历（已发布 / 盘前 / 盘后 / 当日分桶），市值与行情用东方财富补齐。",
  frontend: V0_1_27_ENTRY.frontend,
  software: V0_1_27_ENTRY.software.map(item => item.name === "Fire" ? { ...item, version: "v0.1.28" } : item),
  changes: [{
    title: "财报日历接入港股（雪球财报日历）",
    desc: "港股此前只有「该市场财报数据源暂未接入」的占位。这次接通雪球财报日历：接口走了三轮排查才定位到 —— 雪球前端 bundle 里写的是 `/v5/stock/screener/earnings_calendar/hk/list.json`，必须带登录 Cookie（匿名请求直接 400），参数用 `begin_date` / `end_date` 取区间、并带上 `extend=all` 才会返回整段区间（不带时只回最近几天，传 `type` 等额外参数反而会返回空）。返回按天分组，组内再分「已发布 / 盘前 / 盘后 / 当日」四个桶，正好对上现有的时段口径。实现：`lib/earnings.ts` 新增 `fetchHkMonth()`（每月一次请求 → 按 symbol + 日期去重 → 用东方财富 push2 的 `116.` secid 批量补市值 / 现价 / 涨跌 / 简体名 → 按「单日市值前 5」收敛，与美股 / A 股同一套规则），`EarningsMarket` 增加 HK，`/api/earnings` 放行 `market=HK`；前端港股进入常驻市场（不再收在「更多」里），港股单独一套 HK$ 市值档位、「业绩类型」列显示「2026 中报」这类标签、已发布条目显示「已发布」而不是硬猜盘前 / 盘后，空档月给出港股业绩季说明；设置页新增「港股财报」接口地址（可换源），关于页数据源补上雪球。实测：2026-08 上游回 2093 条事件（已发布 2032 / 盘前 3 / 盘后 14 / 当日 44），按单日市值前 5 收敛后 111 条；2026-09 为 38 条，均带回市值与现价。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "feature"
  }, {
    title: "财报日历文案订正：页脚「行情实时更新」改为「财报实时更新」，并补上港股来源",
    desc: "页脚原文「美股数据来自 Nasdaq，A股数据来自东方财富预约披露，行情实时更新，仅供参考」把财报口径写成了行情；改为「财报实时更新」，并按新接入的港股补上「港股数据来自雪球财报日历」。顺带把页面副标题从「美股 / A股财报」改成「美股 / 港股 / A股财报」。",
    kind: "fix"
  }, {
    title: "财报日历明细列序调整：现价提前、市值后置，日期卡片去掉币种符号",
    desc: "1) 明细表把「市值」与「现价」两列互换位置：现在是 公司 / 现价 / 时段 / EPS 预期（A股为报告期、港股为业绩类型）/ 市值，现价紧跟公司名、市值退到最后；列宽同步调整（现价 112px、市值 112px），md 档位（无市值列）保持 公司 / 现价 / 时段 / 预期 四列。2) 「现价」表头原来居中、而数值是右对齐，看着像和下面的数字脱节 —— 表头改为右对齐，与数值同一条竖线。3) 日历里点日期弹出的紧凑卡片去掉币种符号（`$1.05T` → `1.05T`、`$951.08` → `951.08`）：`fmtCapByMarket` / `fmtPriceByMarket` 增加 `withSymbol` 开关，明细表里仍保留符号；顺带把港股现价补上 `HK$` 前缀（此前与美元同用 `$`）。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "资产分析页新增「盈亏日历」模块，各模块支持拖拽排序（自动保存）",
    desc: "1) 盈亏日历搬过来：把资产盈亏分析页的「收益日历」抽成共享实现 —— 数据口径抽到 `lib/pnlCalendar.ts`（日资产序列 / 月格子 / 年汇总 / 单日每股盈亏，含按订单轨迹推进数量、现金流归入下一交易日、最近有效收盘价回填等既有算法），UI 抽到 `components/PnlCalendar.tsx`（月份切换 + 市场筛选 + 年 / 月 + 收益 / 收益率 + 当天盈亏弹窗），资产盈亏分析页改为引用同一份实现（该文件净减约 450 行），资产分析页右栏底部新增同款模块；两个页面共用一套算法，同一天的盈亏不会出现两个数字。2) 模块拖拽排序：左右两栏各自可拖（左侧 账户资产 / 收益率趋势图 / 持仓盈亏排行 / 资金系统；右侧 账户总览 / 持仓分布 / 订单 / 盈亏日历），鼠标悬停卡片左侧出现手柄，按住手柄才可拖动（避免选文字 / 拖输入框时误触发），落下即写回 `site_settings.assetAnalysisOrder`（左右各一组模块 id），成功 Toast「模块顺序已保存」并派发 `fire:settings-updated`，失败提示重试；服务端保存的顺序与默认顺序合并，之后新增模块自动补在末尾；两栏容器从 space-y 改为 flex + gap 以支持 order 排序。验证：tsc 无错误、冒烟 113/113 全 PASS，并实测 `/api/settings` 的 `assetAnalysisOrder` 存取正常（写入后读回一致，随后已还原）。",
    kind: "feature"
  }, {
    title: "修复全站股票图标刷新后闪现首字母（服务端注入的图标表改为渲染期预热）",
    desc: "现象：刷新页面后，持仓 / 自选 / 资产分析等列表里的股票图标先显示首字母占位（S / T / 英 / 标 …），随后才切成真实图标，肉眼能看到「闪一下」。根因：layout 已经按当前记录算好并在服务端注入了图标表 `initialStockIcons`（还带了 preload），但 `RecordsApp` 只在 `useLayoutEffect` 里调 `primeStockIconCache` —— 子组件（AssetAnalysisView / HoldingsView 等）的首次渲染发生在父组件渲染阶段、早于父组件的 layout effect，那时共享缓存还是空的，于是首帧画的是首字母；等父组件 layout effect 与子组件挂载后的 passive effect 跑完才补上图标，浏览器早已把首字母画到屏幕上。修复：把预热提前到渲染期（`useMemo(() => primeStockIconCache(initialStockIcons), [initialStockIcons])`）——该函数只写缓存、不通知订阅者，不会打断水合，与市场色块的 `primeMarketBadges` 同一套思路；另外把 `useAssetIcons` 里「读 localStorage 缓存」从 `useEffect` 挪到 `useLayoutEffect`，浏览器绘制前就把本地缓存的图标并进首帧（服务端注入没覆盖到的图标同样不再闪）。验证：对 `/asset-analysis` 的首屏 HTML 做 A/B 对比 —— 修复前 3 个 `<img>`、0 个股票图标（整列首字母兜底），修复后 13 个 `<img>`、其中 10 个是股票图标，SSR 首屏直接就是图标。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "fix"
  }, {
    title: "收益日历偏好持久化 + 市场图标随首屏下发 + 当日盈亏明细加股票图标",
    desc: "1) 收益日历的市场选择此前只在资产盈亏分析页做了持久化，资产分析页新增的日历模块是纯 `useState`，刷新就回到「全部」；现在把日历偏好（市场 / 月份 / 年视图 / 收益-收益率）抽成 `lib/pnlCalendar` 的 `readPnlCalendarPrefs` / `savePnlCalendarPref`，两个页面共用同一组 localStorage key（`fire:asset-pnl-cal-*`），资产分析页在 `useLayoutEffect` 里恢复、每次切换即保存，刷新与跨页都保持。2) 市场图标（素材库 type=market）改为随首屏 HTML 下发：新增 `getMarketIconMap()` 与 `primeMarketIconCache()`，layout 把 6 个市场图标一并放进 preload，`RecordsApp` / `HomeContent` 在渲染期预热共享缓存 —— 市场下拉与筛选按钮首帧就是真实图标，不再等客户端请求 `/api/assets` 才有（此前点开下拉要晚一拍才出现国旗）。3) 「当日盈亏」明细弹窗每一行加上股票图标（沿用全站 `stockIcons`，缓存未命中时回退首字母）。验证：tsc 无错误、冒烟 113/113 全 PASS；首屏 HTML 实测已带 6 个市场图标 preload 与 10 个股票图标 preload。",
    kind: "fix"
  }, {
    title: "资产分析页性能 P0：组合数据一次取回 + 首屏让路 + 图表按需加载",
    desc: "先量后改：SSR 热态 0.08–0.6s 并不慢，慢在水合之后 —— 页面一挂载就由浏览器按持仓逐只打 `/api/kline/full`（17 只 ≈ 17 次请求 / 约 520KB），外加订单 5000 全量、资金、汇率、行情，8 个模块全在等这批数据；`/api/kline/full` 虽有 10 分钟服务端缓存，但客户端每次刷新仍要重新拉几百 KB。三处改动：1) 新增 `GET /api/v1/portfolio-series?days=330` —— 服务端按持仓并发（6）取日K，一次返回「recordId → { d, c } 序列 + 订单」，浏览器从 N+3 个请求降到 1+1（基准单独一个小请求，切换基准不用重拉全部），同规模体积 5 只 153KB → 58KB（约 2.6× 小），服务端日K缓存命中时实测 **0.03s**；资产盈亏分析页同步改用这份聚合数据并共享浏览器缓存。2) 首屏让路：聚合取数放到 `requestIdleCallback`（超时 600ms，兜底 setTimeout 150ms）之后，首屏先渲染账户资产 / 总览这些用已有行情就能画的模块；有 localStorage 趋势缓存时本来就直接命中。3) echarts 趋势图改为 `next/dynamic` 按需加载（带骨架）。顺带删掉两个页面里已失效的逐只 kline 缓存与有界并发工具（约 2.6KB 死代码）。验证：tsc 无错误、冒烟 113/113 全 PASS；接口实测首调 1.37s、二次命中 0.03s。",
    kind: "feature"
  }, {
    title: "资产分析性能 P1：聚合接口上 ETag（命中 304 不重传）+ 订单刷新口径对齐",
    desc: "给 `/api/v1/portfolio-series` 加 ETag 条件请求：指纹只按内容算（closes 按 recordId 排序后再序列化 —— 它是并发取回的，键顺序每次都可能不同，不排序会导致 ETag 每次都变、304 永远不命中；订单只取影响序列结果的字段，避免无关字段抖动），响应改为 `Cache-Control: private, max-age=30, must-revalidate`；顺带发现 next.config.mjs 里 `/api/:path*` 的全局 `no-store` 会覆盖路由自身的缓存头，为这个接口加了一条更具体的例外。客户端 `fetchPortfolioBundle` 默认走浏览器 HTTP 缓存（只有强制刷新才 no-store）。实测：连续三次请求 ETag 稳定，带 If-None-Match 命中 **304、下载 0 字节**（此前每次重传约 58KB）。另外把「订单」模块的刷新从 limit=500 对齐到 5000，避免刷新后列表从 5000 缩到 500。tsc 无错误、冒烟 113/113 全 PASS。",
    kind: "feature"
  }, {
    title: "新增「卡面库」：按 国家地区 / 卡类型 / 银行 三层归档的卡面素材与浏览页",
    desc: "导航新增「卡面库」（素材库下方、日志上方；写进 NAV_KEYS 与默认页签，老用户的导航会由 parseTabs 自动补位）。素材：`scripts/fetch-card-assets.mjs` 从 GitHub HarukaKinen/Cardentify 的 main 分支 Cards/ 抓取（该仓库默认分支已变成 DMCA，脚本固定用 main），107 家银行的 436 张卡面 → 统一转 WebP（最长边 1000px、质量 82），312MB 原图压到约 20MB，落地 `public/uploads/cards/<国家地区>/<卡类型>/<银行>/<卡名>.webp` 并生成 `manifest.json`（地区 → 银行 → 卡，含 类型 / 卡组织 / 等级 / 卡号前几位）；脚本可重复运行（默认跳过已存在，支持 --force / --limit / --bank），换图加卡只跑一次脚本。分类：按上游 `card.type` 分 借记卡 251 / 信用卡 172 / 预付卡 1 / 其他 10，映射表另预留签账卡 / 取现卡 / 交通卡 / 礼品卡 / 虚拟卡；同时在清单里记录了**卡组织**（银联 / Mastercard / Visa / AMEX / JCB / Mir）与**等级**（普卡 / 金卡 / 白金 / 世界 / 无限…），后续做筛选不必重抓。页面 `/cards`：地区 + 类型两级胶囊筛选（带数量）、搜索（卡名 / 银行 / 卡组织）、响应式卡面网格（图片懒加载），点击卡面弹出大图与元信息，**不含下载按钮**；弹窗底部预留「录入金额」输入框 + 保存按钮（本版置灰占位，功能下一版接入）。接口 `/api/cards` 登录后读取清单（60 秒内存缓存）；`public/uploads/cards/` 加进 .gitignore —— 卡面属于本地素材，不进仓库、不随镜像分发，换图只影响本地。冒烟测试新增 /cards 页面巡检：tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "feature"
  }, {
    title: "卡面库：录入金额功能上线 + 卡组织/等级/主题筛选与悬停打磨",
    desc: "1) 录入金额：新增 `card_amounts` 表（user_id + cardKey 主键，金额 / 币种 / 备注 / 更新时间）与 `lib/cardAmounts.ts`，接口 `PUT/DELETE /api/cards/amounts`（校验金额 ≥0 且 ≤1e12、卡面标识 ≤300 字符、备注 ≤100 字符，并带限流），`GET /api/cards` 顺带回当前用户已录入的金额；弹窗里的金额输入框 / 币种（按地区自动预选，如中国内地→CNY、中国香港→HKD、美国→USD）+ 备注已可用，保存后卡片左下角显示金额胶囊、顶部「已录入 N」可一键只看已录入；cardKey 在服务端做「分段 URL 编码」归一化（幂等），前端传编码或解码形式都能对上。2) 筛选与打磨：地区 + 类型常驻，「更多筛选」展开后是 卡组织（银联 / Mastercard / Visa / AMEX / JCB / Mir）/ 等级（普卡 / 金卡 / 白金 / 世界 / 无限…）/ 主题；主题标签按卡名关键词自动生成（联名 IP、虚拟卡、生肖、纪念限定、校园青年、商旅航空、动物萌系、数字银行、金卡白金以上），卡片上最多显示 3 个、弹窗显示全部；卡面悬停有上浮 + 图片轻微放大 + 渐变压暗 + 右上角类型角标，列表与弹窗都支持。tsc 无错误、冒烟 114/114 全 PASS（含 /cards 页面巡检）。",
    kind: "feature"
  }, {
    title: "卡面库第三版：金额汇总（按币种 + 折算）、我的标签编辑器、网格分页加载",
    desc: "1) 金额汇总：卡片列表上方新增一条汇总 —— 按币种分别合计（`CNY 12,000 ×3` 这样逐条列出），再用当前汇率折算成显示货币给出「≈ ¥xx」；汇率沿用全站既有链路（首帧 FALLBACK_RATES、挂载前合并本地缓存、随后 /api/rates 刷新，符合首帧一致性约定）；ECB 不发布 MOP，给澳门元补了「与港币锚定 1 HKD ≈ 1.03 MOP」的兜底汇率，RUB / KZT 没有可用汇率就单独标注「未计入折算」而不是按 1:1 误算。2) 我的标签：新增 `card_tags` 表（user_id + cardKey + tag 主键）与 `PUT /api/cards/tags`（覆盖式保存、去重、去空格、单个 ≤12 字、最多 10 个，带限流），`GET /api/cards` 一并返回；弹窗底部可增删标签（回车添加 + 常用建议：虚拟卡 / 实体卡 / 金属卡 / 透明卡 / 收藏 / 主力卡 / 已注销 / 纪念版），我的标签用蓝色区分于自动主题标签，卡片上最多显示 3 个；筛选区「更多筛选」新增「我的标签」一组（只在有标签时出现）。3) 网格分页加载：一次只渲染 60 张，底部「加载更多（剩余 N 张）」按钮继续追加（筛选条件变化自动回到第一屏），434 张不再一次性铺满 DOM。验证：tsc 无错误、冒烟 114/114 全 PASS；标签接口实测去重 / 去空格 / 清空均正确，测试数据已清理。",
    kind: "feature"
  }, {
    title: "卡面库改为原图直存（PNG / JPG / SVG 原样）+ 弹窗补原图信息",
    desc: "按选择把抓取脚本的默认格式从「转 WebP 压缩」改成「原图直存」：`scripts/fetch-card-assets.mjs` 新增 `--format=original|webp`（默认 original），original 模式不再走 sharp 转换，按上游原始字节与原始扩展名保存（`.jpeg` 统一成 `.jpg`）。重抓结果：**436 张全部成功、0 失败**，占用 313MB（图片 311.8MB），格式分布与上游完全一致（PNG 395 / JPG 20 / SVG 19 / WebP 2）；顺带修好了 WebP 模式里因超出 XML 解析上限而失败的那张玉山银行超大 SVG —— 原样保存不做解析自然绕过。清单为每张卡补了 `bytes`（原图字节数），卡面弹窗底部新增一行「原图 PNG · 1.3 MB · 中国内地 / 借记卡」，方便一眼确认是原图。日后想换回轻量版：`node scripts/fetch-card-assets.mjs --format=webp`（约 20MB，网格更快）。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "feature"
  }, {
    title: "卡面库改为「我的卡包」：默认只显示持有的卡，全量库作为挑卡入口",
    desc: "一个人不可能持有几百张卡，所以卡面库不再默认铺开全部 436 张：新增 `card_holdings` 表（user_id + card_key 主键）与 `PUT /api/cards/holdings`（加入 / 移出，带限流），`GET /api/cards` 一并返回持有的卡；页面右上角是分段切换「**我的卡 N** / 全部卡面 436」，默认进「我的卡」——只显示自己持有的卡，没有则显示「还没有添加卡片 —— 卡面库默认只显示你持有的卡」并给一个「去全部卡面挑一张」的入口。在「全部卡面」模式下每张卡右下角有「+ 加入」（已持有的显示「移出」）、左上角有蓝色「我的卡」角标；弹窗底部也有一键「加入我的卡 / 移出我的卡」。另外录入金额的卡会自动视为持有（服务端处理）——否则会出现「录了金额却在默认列表里看不到」的困惑。原有的筛选（地区 / 类型 / 卡组织 / 等级 / 主题 / 我的标签 / 已录入）与金额汇总在两种模式下都照常可用。验证：tsc 无错误、冒烟 114/114 全 PASS；持有接口实测加入 / 移出 / 读取正确、录入金额会自动加入我的卡，测试数据已清理。",
    kind: "feature"
  }, {
    title: "卡面库筛选区按参考站重构：类型胶囊置顶 + 地区/银行/卡组织/等级/主题 下拉，胶囊换实心选中态",
    desc: "按参考卡面库的排版重排筛选区：1) 「类型」胶囊移到最上面一行（保留我们的计数显示）；2) 下面改成一排下拉框 —— **地区 / 银行 / 卡组织 / 等级 / 主题**（有自定义标签时再加「我的标签」），样式对齐参考图（浅色圆角 + 右侧箭头，深浅色都适配）；其中**银行列表跟随所选国家地区**（选「中国内地」只列内地银行，选「全部地区」时按地区分组用 optgroup 展示，切换地区会重置已选银行），银行下拉同时显示中英文名、取值用银行文件夹名保证唯一；3) 搜索框独立成一行（对齐参考图的宽度与占位文案「搜索银行、卡片名称或关键词」），不再挤在标题右侧；4) 胶囊样式整体换成参考图的实心选中态：选中 = 深色实心 + 白字（深色模式反相为白底深字），未选中 = 白底细边框 + 深字，同时去掉原来包住胶囊的边框盒子；「已录入 N」与「我的卡 / 全部卡面」切换也统一成同一套胶囊，避免一页里出现两种选中态。注：该实心选中态是本页按参考图定制的，未改动全站「中性色按钮标准」。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "feature"
  }, {
    title: "卡面库地区下拉按洲分组排序，中国各地放最前",
    desc: "地区下拉原来按卡面数量排，中国内地 / 台湾 / 香港 / 澳门被拆散夹在美日英中间，看着乱。现在按**洲**分组（optgroup）排序：亚洲（中国内地 → 中国台湾 → 中国香港 → 中国澳门 → 日本 → 新加坡 → 哈萨克斯坦）→ 欧洲（英国 → 俄罗斯 → 德国 → 爱尔兰）→ 北美洲（美国 → 加拿大）→ 大洋洲（澳大利亚）；洲内规则是「中国各地优先，再按卡面数量」。银行下拉在下探到「全部地区」时同样按这个顺序分组，组名带洲前缀（如「亚洲 · 中国内地」），查找更顺。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "feature"
  }, {
    title: "卡面库新增「我的卡」总览条，筛选计数按当前模式（我的卡 / 全部卡面）统计",
    desc: "在搜索框下方加了一条「我的卡」总览：**我的卡 N 张 · 各类型张数（按数量排，如 信用卡 12 / 借记卡 15）· 额度合计 ≈ ¥xx**（沿用按币种合计 + 汇率折算的口径，没有录入时显示「未录入（打开卡片可录入金额）」）；第二行保留按币种的明细胶囊（`CNY 12,000 ×3`）与「无汇率未折算」提示。原来那条只按币种的「金额汇总」合并进这条总览，信息不再重复。顺带修一处不一致：筛选区（类型 / 地区 / 银行 / 卡组织 / 等级 / 主题 / 我的标签）的计数原来一律按全量 436 张统计，在「我的卡」模式下会出现「我的卡只有 3 张、类型却写着借记卡 251」这种自相矛盾；现在所有计数都跟随当前模式（我的卡 → 只统计持有的卡，全部卡面 → 全量），银行下拉也只列当前作用域里出现过的银行。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "feature"
  }, {
    title: "修掉输入框 / 下拉的蓝色聚焦框：全局「无轮廓」规则补上文本类控件",
    desc: "现象：卡面库的搜索框与下拉一聚焦就出现一圈深蓝色描边，和全站的中性风格不搭。根因：globals.css 的「苹果风格焦点：点击/激活/聚焦一律无轮廓、无光晕」只覆盖了 `button` / `a` / `[role=button]` / `input[type=button|submit]`，**文本输入、文本域、下拉没被覆盖**，于是保留了浏览器默认的 focus ring（Chrome/Safari 下就是那圈蓝色）。修复：把 `input:not([type=checkbox]):not([type=radio])`、`textarea`、`select` 的 `:focus` 与 `:focus-visible` 一并补进全局 `outline: none` 规则（复选框 / 单选框保留它们自己的焦点样式，避免误伤行情板等已有设计）。同时给卡面库的搜索框、下拉、金额 / 备注 / 标签输入补上全站同款的中性灰柔光焦点反馈（`focus:shadow-[0_0_0_3px_rgba(107,114,128,.15)]`，与 `.field:focus` 一致；金额输入用 `focus-within` 让外层带边框的容器一起响应），去掉蓝框后仍能一眼看出焦点在哪。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "fix"
  }, {
    title: "卡面库筛选计数改为分面联动（搜索 / 其他条件变化时各维度数字同步）",
    desc: "现象：搜「招商」后列表只剩招商银行的卡，但「类型」胶囊仍写着 全部 436 / 借记卡 253 / 信用卡 172 / 预付卡 1 / 其他 10 —— 数字和结果对不上。根因：各维度的计数是拿「当前模式的全量集合」直接算的，完全没参考搜索词与其他筛选。改为标准的分面（facet）统计：统计某个维度的数字时，把这个维度**自己**排除在外、其余条件（模式 / 搜索词 / 地区 / 银行 / 卡组织 / 等级 / 主题 / 我的标签 / 已录入）全部生效 —— 于是搜「招商」时类型胶囊会显示 全部 85 / 借记卡 60 / 信用卡 24 / 其他 1，卡组织下拉只剩 UnionPay 83 / MasterCard 1，银行下拉只剩招商银行；同理选了「借记卡」后地区与银行下拉的数字也会跟着变。地区与银行的下拉选项列表本身也随条件收敛（不会出现「选了条件却列出一堆必然为 0 的选项」）。tsc 无错误、冒烟 114/114 全 PASS（用本地素材清单核对过搜索「招商」的分面数字）。",
    kind: "fix"
  }, {
    title: "「我的卡」总览条只在我的卡模式显示",
    desc: "上一条总览（我的卡 N 张 · 各类型张数 · 额度合计）在切到「全部卡面」挑选时也会出现，而那时页面统计的是全量 436 张，两套数字并排容易让人以为统计错了。现在总览条只在**我的卡**模式下显示；「全部卡面」模式的规模信息由标题下那行（全部卡面 436 张 · 14 个地区）承担。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "fix"
  }, {
    title: "卡面格子改「卡片底托」：统一圆角与留白，不再出现直角和白块",
    desc: "现象：只有泡泡玛特 atm 那张看起来像一张实体卡（它的素材自带透明圆角），青鸟 / 乡村振兴 / 京东闪付 这类满幅矩形素材贴到格子底边就成了直角、和下面的标题区连成一片。实测素材本身没问题：436 张里 435 张都是 1.57–1.62 的标准卡比例（另 1 张 1.53），sharp trim 也确认没有留白，差别只在素材自身有没有做圆角。改法：给每张卡加一层「卡片底托」——图片外层留 10px 内边距并铺浅灰底（深色模式为白色 4% 透明度），图片本身用 10px 圆角裁切 + 一圈极淡描边（ring-black/5，深色 ring-white/10）+ 轻阴影；不论素材是否自带圆角，四角都是圆的、底边与标题区之间有明确留白，整体读起来就是「桌面上放着一张卡」。悬停放大、金额胶囊、我的卡角标、类型角标、+ 加入 全部保留在卡面内。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "fix"
  }, {
    title: "卡面库筛选支持多选：类型胶囊可多选，四个下拉换成勾选面板",
    desc: "每个维度从单选改成多选：**类型**胶囊直接多选（点「全部」清空选择），**地区 / 银行 / 卡组织 / 等级 / 主题 / 我的标签**换成自定义多选面板（按钮显示已选摘要，如「借记卡 +1」「招商银行 +2」，展开后逐项勾选、带计数与洲 / 地区分组标题）。筛选语义：**同一维度内 OR、跨维度 AND**（例如「借记卡 + 信用卡」且「招商银行 + 交通银行」）。分面计数同步适配多选：统计某维度时排除该维度、其余条件生效，因此勾了「借记卡」后地区 / 银行下拉里的数字会自动变成借记卡的分布。另加了「清空全部筛选」按钮（有任一条件时出现，连带清空搜索词），银行下拉在选了多个地区时会用「洲 · 地区」分组标注避免同名混淆。tsc 无错误、冒烟 114/114 全 PASS（顺手删掉了改用多选后不再需要的单选下拉组件）。",
    kind: "feature"
  }, {
    title: "修复多选下拉勾选后面板关不掉（label 把点击转发给了开合按钮）",
    desc: "现象：多选面板里勾一项之后面板好像「卡住」——关不掉、页面其他操作也点不动。根因：面板外层用的是 `<label>`，而 label 会把内部任意点击**转发给它关联的控件**（这里是第一个可聚焦元素，即开合按钮），于是「点选项 → 面板关闭 → label 再把这次点击喂给按钮 → 又打开」，点遮罩关闭同理，看起来就像一直保持打开。修复：把多选组件的外层 `<label>` 换成 `<div>`（自定义下拉本就不需要 label 语义，无障碍属性由按钮的 title / 文案承担）。同页其余 label 都是包着原生输入控件的（搜索框、金额、币种、备注），属于正确用法，保持不变。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "fix"
  }, {
    title: "卡面库首屏改服务端注入：刷新不再等「HTML → JS → 水合 → 再请求」",
    desc: "现象：刷新 /cards 后要等一会儿卡片（或骨架屏）才出现。实测接口本身只要 11–30ms（清单 230KB、JSON 解析 0.9ms），真正的开销是串行链路 —— 首屏 HTML 里完全不含卡面数据（实测 /uploads/cards/ 出现 0 次），必须等 JS 下载 + 水合完成才能发起 /api/cards，卡面图片更要等这一步之后才开始加载。改法沿用项目里股票图标 / 市场图标的同款做法：布局在服务端鉴权后直接读清单与该用户的持有 / 金额 / 标签（新增 `lib/cardLibrary.ts`，清单 60 秒内存缓存），**只在访问卡面库这一页时**注入 `initialCardLibrary`，RecordsApp 透传给组件并在 useState 初始化时使用 —— 服务端与客户端首帧一致，水合不打架；挂载后仍会静默刷新一次 /api/cards（供跨设备改动），有注入时不再显示骨架屏、请求失败也不打扰。验证：给 demo 临时加入 3 张卡后抓 /cards 的 HTML，首屏直接含 3 个 `/uploads/cards/` 的 `<img>`（修复前为 0），随后已还原。顺带把卡面 key 的长度上限从 300 提到 600 字符（清单里最长 282，属防御性放宽）。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "fix"
  }, {
    title: "卡面库地区下拉加国旗（取素材库旗帜）",
    desc: "地区多选面板里每个地区前面加上对应国旗：新增「地区 → ISO 二字码」映射（中国内地 CN / 中国香港 HK / 中国澳门 MO / 中国台湾 TW / 日本 JP / 新加坡 SG / 哈萨克斯坦 KZ / 英国 GB / 德国 DE / 爱尔兰 IE / 俄罗斯 RU / 美国 US / 加拿大 CA / 澳大利亚 AU），用现成的 `CurrencyFlag` 渲染 —— 它优先取素材库里用户上传的自定义旗帜、没有再回退内置的本地 SVG（`public/uploads/asset/flag/*.svg`，14 个码全部存在），不依赖任何远程 CDN。国旗同时出现在多选面板的每一行与选中后的按钮摘要里（选了一个地区时）。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "feature"
  }, {
    title: "下拉面板滚动条改细（全局 .thin-scrollbar）",
    desc: "卡面库的多选面板（地区 / 银行 / 卡组织 / 等级 / 主题 / 我的标签）用的是浏览器默认滚动条，在深色背景下又宽又抢眼。新增全局工具类 `.thin-scrollbar`：滚动条宽 4px、轨道透明、滑块用 999px 圆角 + 半透明灰（hover 略深），`scrollbar-width: thin` 让 Firefox 同样细；深色模式滑块换成 26% 白色。多选面板套用该类，列表再长也是细细一条。tsc 无错误、冒烟 114/114 全 PASS。",
    kind: "fix"
  }, {
    title: "修复多选面板里相邻已选项的选中底色粘成一块（选项行之间补间距）",
    desc: "现象：在卡面库的多选面板里连着勾两项（如「中国内地 + 中国台湾」），两行的蓝色选中底色上下直接贴死，中间的圆角被吃掉，看起来像一整块色带（截图见问题反馈，深浅色模式都一样）。根因：面板容器只有 `p-1` 的内边距，各选项行之间没有任何垂直间距，两个 `rounded-lg` 的相邻底色相接时圆角与圆角叠在一起就糊成一片。修复：给面板容器加 `space-y-1`（相邻行之间留 4px 间距），每行各自保留独立圆角，勾选 / 悬停 / 「全部地区」这一行与分组标题之间同样有呼吸感；六个多选面板（地区 / 银行 / 卡组织 / 等级 / 主题 / 我的标签）共用同一个组件，一处改动全部生效。验证：tsc 无错误、冒烟 114/114 全 PASS；并在本地开发服务器上用无头 Chrome（430px 宽、深色模式、勾选中国内地 + 中国台湾）抓了修复前后两张对照图 —— 修复前两行底色连成一块，修复后是两个带圆角的独立选中行。",
    kind: "fix"
  }, {
    title: "卡面库新增「卡包」：整屏堆叠切卡 + 卡背（有效期/安全码）+ 余额历史（存钱/取钱）",
    desc: "把卡面库从「挑卡看图」升级成真正的银行卡管理。标题旁新增「卡包」入口（堆叠图标按钮），点开进入整屏深色堆叠视图（`components/CardWalletStack.tsx`）：GSAP 驱动上下滑动切卡 —— 拖动跟手、松手按距离 + 速度判定翻页（首尾有阻尼回弹），滚轮 / 方向键 / PageUp·Down / 空格 / 点按非顶卡都能切，卡片按银行 / 余额 / 卡名排序（排序偏好 localStorage 持久化）。卡包下方显示「银行 · 卡名」与当前余额。每张卡都有正反两面：点按最上面的卡进详情，卡片可 3D 翻转（`perspective` + `backface-visibility`），反面按真实银行卡画了磁条、签名栏、安全码、有效期与尾号（卡号 / 有效期 / 安全码只存本地数据库，详情里可一键「显示 / 隐藏」）；详情里能编辑卡号 / 有效期 / 安全码 / 备注 / 币种。余额历史：每张卡记「存钱 / 取钱 / 余额调整」流水（含日期与备注），余额 = 首笔发生前的余额 + 逐笔重放，删除任意一笔会自动重算后续余额，与卡面库金额胶囊 / 总览条是同一份数据。落地：新增 `lib/cardWallet.ts`（卡背信息 + 余额流水 + 重放删除）、`lib/cardCurrencies.ts`（14 种币种 / 地区默认币种 / 金额与卡号格式化）、`/api/cards/wallet`（GET 卡背+流水 / PUT 卡背 / POST 记流水 / DELETE 删流水，均带登录鉴权、限流与卡面 key 归一化）；数据库新增 `card_details` 与 `card_balance_history` 两张表；`cardLibraryForUser` 首屏一并注入卡背信息。卡面库金额 `card_amounts` 与卡包余额共用一份数据源，资产分析资金系统 / 可用现金的联动留待下一步。tsc 无错误、npm run build 通过。",
    kind: "feature"
  }, {
    title: "卡包余额联动资产分析：借记卡 / 预付卡余额并入可用现金与净资产",
    desc: "按确认口径把「我的卡」里**借记卡 / 预付卡**的余额当作真实现金接进资金系统。1) 新增 `cardCashByCurrency()`（`lib/cardLibrary.ts`）：只统计持有中的借记卡 / 预付卡余额 —— 信用卡的「金额」是**额度**不是余额，一起相加会让净资产虚高；卡币种取值顺序与卡包显示完全一致（金额上的币种 → 卡背币种 → 地区默认币种），保证「卡包上看到的这个余额」和「算进现金的这个余额」是同一笔；没有汇率的币种（卢布 / 坚戈）宁可不算，也绝不按 1:1 当成美元。2) `/api/v1/funds` 把它并进对应币种的 `balances` 并额外返回 `cardCash` 明细，于是资产分析的**可用现金 / 净资产**、资金系统的**期末总资产**、我的持仓的**总资产**都是同一份现金口径（三处读同一个接口）。3) 同时并进 `summaries[币种].otherNetFlow`：资金系统的等式是「盈亏额 = 期末总资产 − 期初总资产 − 当期净投入」，卡里的钱只进期末、不进净投入会被算成投资收益（凭空多出来的盈利），并进其他净流入后等式依旧成立，语义上也对 —— 这笔钱确实是从账本外面流进来的。4) 资产分析「账户资产」新增**银行卡现金**统计卡（按显示货币折算，悬停说明「信用卡额度不计」），资金系统的温馨提示与卡包详情底部各补一条口径说明，不再黑箱。5) 顺带修一处会吃掉卡余额的边界：简化版账本按「该市场总资产 − 持仓」反推现金时会整块覆盖该币种余额，现在把卡余额加回去。验证：tsc 无错误、npm run build 通过；demo 实测 `/api/v1/funds` 的 balances 已含 CNY 10,719.50 与 HKD 94,200.66（Apple Card 的 USD 4,499.45 属信用卡，正确排除），`otherNetFlow` 同步，盈亏额不受影响。",
    kind: "feature"
  }]
};

export const CURRENT_VERSION_ENTRY: VersionEntry = V0_1_28_ENTRY;

// 完整历史数组已拆分到 lib/versions-history.ts（约 200KB 历史文案，仅供版本弹窗
// 懒加载引用）；本文件保留类型 + 当前版本条目，让设置页 / 健康检查只引用轻量常量。
export const CURRENT_VERSION: VersionEntry = CURRENT_VERSION_ENTRY;
