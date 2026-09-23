# AGENTS.md — Fire 投资记实

## 项目

- 技术栈：Next.js 15（App Router）+ React 19 + TypeScript + Tailwind CSS，SQLite（better-sqlite3）。
- 常用命令：开发 `npm run dev`（固定监听 `0.0.0.0:3000`，禁止临时切换端口）；构建 `npm run build`；冒烟测试 `./scripts/smoke-test.sh`（期望全部 PASS，测试会备份并还原设置，不污染用户数据）。

## 收尾 Review 规范（重要）

- **每完成一个大功能 / 新建一个页面 / 一次较大重构 / 一次大的 UI 调整，收尾前必须做一次 Review**：先自查、修完所有发现的问题，再交付；禁止在仍有明显 bug / 未决问题时就交“半成品”。

Review 自查清单（按项目实际走一遍）：
1. **编译/类型**：`npx tsc --noEmit` 通过；相关页面可正常编译加载。
2. **逻辑一致性**：涉及数据 / 金额 / 统计改动时，核对**同一数值在不同视图是否同源、一致**（例如 FIRE「当前资产」上方卡片与水球、每年明细「当前资产」必须同值）。
3. **持久化**：新增“刷新要保持”的状态按「状态持久化决策树」选 URL / localStorage（`fire:xxx`）/ 服务端；不得刷新即还原。
4. **深色模式**：新增颜色 / 透明度 / hover 背景变化时同步补 `app/globals.css` 的 `.dark` 覆盖；深浅色都要检查。
5. **图标唯一性 + 命名规范**：新增导航 / 设置图标按「交互与适配约定」注册专属图标；素材 / 文件命名按「素材库文件命名规范」；股票/ETF 名称按规范三表同步。
6. **HTML 合法性**：禁止按钮嵌套按钮（`<button>` 内 `<button>`）等 hydration 错误；嵌套点击项用 `span role="button"`（或改成并列兄弟元素）。
7. **汇率 / 货币**：涉及币种展示时确认按「默认/主货币 → 显示币种」换算，未把显示币种当主货币；收益率 / 进度等比值不随币种改变。
8. **版本记录**：按「版本记录约定」把本次变更写入 `lib/versions.ts` + 仓库根 `VERSIONS.md`。
9. **冒烟测试**（影响全局 / 数据源 / 设置时）：跑 `./scripts/smoke-test.sh`，期望全 PASS。

- 交付答复里写明：改了哪些文件、Review 结论、是否还有遗留风险 / 待办。

## 排序与拖动：全局持久化约定（重要）

- 所有排序类交互必须**全局生效**：结果保存到 `/api/settings`（`markets`、`tabs`、`groups`、`homeNav`），禁止只存在组件本地状态。
- 可拖动的区域（账户资产市场标签、设置-导航菜单、设置-分组管理、网站管理-首页导航）统一使用 HTML5 拖拽：拖动手柄 + 拖动排序 + 保存后 Toast 提示；保存成功后派发 `fire:settings-updated` 事件（或通过回调同步父级状态）让全站立即一致。
- 新增任何可排序/可拖动 UI 时沿用此约定（拖动手柄、持久化、事件通知、Toast），不要做成"刷新即还原"。
- **例外**：3D 车型条的顺序属于 showcase 自己的登记表（uploads 卷的 showroom.json），不走 `/api/settings` —— 见下节「3D 车型导入与车型条」。
- **我的持仓市场标签按记录显隐**：`settings.markets` 只负责市场顺序，标签只为「有持仓 / 本页添加记录」的市场显示 —— 空市场自动隐藏（与自选股「空分组自动隐藏」一致），避免出现「日股 0」这类空标签；新增该市场记录后标签自动出现，市场编辑面板对空市场标注「无记录 · 自动隐藏」。

## 3D 车型导入与车型条（2026-09-20 起）

- 首页右下角车型条 = **内置车**（`components/showcase/presets/models.ts` 的 `SHOWCASE_MODELS`，目前只有随仓库分发的 MCL35M）+ **导入车**；导入入口是车型条末尾的「＋」（**仅管理员可见**），页面 `/showcase/import`。
- **车型相关写接口一律限管理员**（`upload` / `cover` / `order` / `[id]` 的 PUT+DELETE / `models` 的 POST）：车型条是首页对外的公共内容、素材经 `/uploads` 公开可下载，普通用户只读；新增展示台写接口时照这条挡（与素材库 / 名人 / 站点设置的惯例一致）。
- **素材与登记表都放 uploads 卷**：`public/uploads/mclaren/models/*.glb`（导入的模型）、`covers/*`（自定义封面）、`showroom.json`（登记表）—— 三者都不进 Git、不进镜像（100MB+ 的 glb 会被公开仓库审计拦）。只有 MCL35M 的模型与两张 HDR 随仓库放 `public/mclaren/`；**禁止把导入的车型素材再塞回仓库**。
- **顺序与封面只认 showroom.json**（`order` / `models[].cover` / `builtinMeta[内置车 id].cover`）：这是「排序结果存服务端」约定的 showcase 分支，排序走 `PUT /api/showcase/models/order`，**不要存 localStorage / 组件本地状态**。
  - 顺序表缺项时按 `lib/showcaseModels.ts` 的 `resolveOrder` 兜底：内置车补最前、其余补末尾；导入页与首页车型条必须共用这一个函数，禁止各排一套（曾出现「导入页排最后、首页排最前」）。
  - 保存顺序时内置车的 id 必须留在顺序表里（曾因为过滤掉它，内置车掉出顺序表、被排到最后）。
- 卡片：封面高度 = 卡宽 × **52%**（`aspect-[100/52]`，实测「车不被切」的临界比例，再小就裁到车头 / 轮胎），角标（⠿ / 内置 / 年份）压 48px 上缘渐变，保证白底封面也读得清；操作胶囊在桌面三列宽度下必须同一行显示。
- 内置车也能换封面（记 `builtinMeta`，素材与参数仍随仓库分发），但不能改参数、不能移出清单 / 删除；导入车可改参数 / 换封面 / 去封面 / 移出清单 / 删除并删文件。
- **仅保存成功才保留附件**：体检文件写系统临时目录并在请求结束时删除；工作台用当前页面的 Blob 预览，不写 uploads / Cache Storage / IndexedDB。取消、离开或新车型保存失败都释放未保存附件；保存时重新提交原文件与参数，登记表写入失败回收新文件。旧 `.draft-` 附件通过 `cleanupOrphanFiles({ scope: "showcase-unsaved" })` 清理，只保护登记表已引用的车型。已保存车型的参数草稿可保存在浏览器，不能混同于未保存附件。
- **行驶最高时速属于车型参数**：导入车的 `params.topKmh` 存在 showroom.json，首页切车时同步到当前场景；不能把 MCL35M 的 340 km/h 当成所有车型的上限。旧 Gulf F1 与 MP4/6 无此字段时分别兼容 350、335 km/h，用户在工作台保存的数值优先。改遥测时验证至少两辆不同上限的车。
- 细节与操作流程见 `docs/showcase-3d.md`。

### 高清模型切换交付门槛（2026-09-23 起）

- 改首页车型、画质或模型加载链路时，先明确“用户已选择的档位”“正在加载的目标”“实际已显示的模型”三种状态；异步成功前不得把目标当作已显示模型。选中反馈应立即出现，加载进度应可见，失败时旧车继续可见并提供重试。
- 提交前必须在本地页面实际操作：手机 390×844、平板 768×1024、桌面各测 1K→2K→4K→原画及反向切换；至少覆盖内置车型和一辆导入车型，再测快速连续点选、切换中换车型、刷新保留所选档位、加载失败后的旧车与重试。检查画面是否出现空车、黑屏、错误车型、错误高亮或无法操作。
- 浏览器改视口只证明响应式布局和当前浏览器的切换行为，不等于真实手机 GPU / 内存压力测试；能连接实体设备时补做，否则交付时明确说明未覆盖。`npx tsc --noEmit`、`npm run test:review` 与 `git diff --check` 通过，且上述可执行的实测无问题后才提交并推送。若有失败，先说明触发条件、根因、修复方案及已实现的效果，不把未经验证的修复称为完成。
- 改首页线框、后期处理或行驶渲染分支时，必须分别以原生、叠加线框、纯线框点按起步检查隧道光条；模型展示的直接渲染和首页静止线框的性能路径不能使行驶中的隧道合成失效。运行 `node tests/showcase-tunnel.cjs` 并实地看画面。

## 状态持久化决策树（重要）

新增任何"刷新后要保持"的状态，先按下面规则选持久化方式，不要随手拍脑袋：

1. **当前视图状态 → URL 参数**：tab、市场筛选、货币、排序、个股详情 `?symbol=`、自选股筛选 `?filter=` 等"此刻看什么"——可分享/收藏、刷新与前进后退天然保持；中文值用 `encodeURIComponent`。
2. **个人偏好 → localStorage**：货币默认、趋势周期、图表 tab、加权方式、隐藏态、列排序/列设置、刷新间隔等"我喜欢怎么用"——用 `lib/usePersistedState.ts`（key 用 `fire:xxx` 统一前缀，稳定命名，方便日后迁移）；单机即时生效。
3. **全局 / 跨端共享配置 → 服务端**：券商、自选股分组（`watch_groups`）、列定义（`holdingColumns`）、站点设置——Web 与 iOS 必须一致。

判断口诀：**能分享用 URL，只关自己用 localStorage，要同步用服务端**。URL 优先于 localStorage（视图类），localStorage 优先于 URL（偏好类，避免地址栏噪音）；不要把大/敏感数据放 URL 或 localStorage。

### 首屏不许闪：偏好必须能"服务端预知"（重要，2026-09-13 起）

只用 localStorage 存偏好时，服务端首帧只能画默认值，客户端挂载后才切回用户的选择 —— 刷新会**先闪一下默认值再跳回去**
（历史上反复出现：展示货币先画美元、卡面库显示方式先画「原文」）。规矩：

- **凡是"刷新后要保持、且首屏看得见"的偏好，一律走 `usePersistedState`**，它现在会自动把值镜像到 `fire_prefs` cookie，
  根布局（`app/layout.tsx`）读出后用 `PrefsProvider` 注入，服务端与客户端首帧都是用户的选择，零闪烁。
- **禁止**在组件里直接 `localStorage.getItem(...)` 去决定首屏 UI（排序、选中态、货币、折叠状态…）：
  那既会闪默认值，严重时还会和 SSR 打架触发 `Hydration failed`。数据缓存（行情、K 线、快讯）可以直接用 localStorage，不受此限。
- 需要新增的偏好只要用这个 hook，就自动获得"cookie 镜像 + 服务端注入"；**不要自己再造一套 cookie 方案**
  （例外：主题 `fire.theme` 走根布局内联脚本、展示货币走 `CurrencyProvider`，都是既有实现，保持不动）。
- 老用户迁移：cookie 里没有、localStorage 里有时，hook 会在挂载后补写一次 cookie（这一次仍会闪，之后不再闪）；
  两侧不一致时以 localStorage 为准并回写 cookie，自愈。

## 自选股分组（方案 A：独立分组实体，2026-08-09 起）

- 分组是服务端独立实体（`watch_groups` 表，见 `lib/watchGroupsStore.ts`），记录通过 `watch_group_id` 归属；券商仍走 `records.group_name`（持仓显示），**禁止再把券商名当分组名用**。
- 接口统一走 v1：`GET/POST /api/v1/watch-groups`、`PUT/DELETE /api/v1/watch-groups/{id}`、`POST /api/v1/watch-groups/reorder`、`POST /api/v1/records/group-assign`；重命名 / 删除分组只改实体 + 一条 SQL 清空归属，**禁止循环逐条 PUT 记录**。
- 市场分组（美股/港股/A股/新加坡/日股/韩股）是内置实体：不可删除、动态按 `records.market` 过滤（大前提逻辑，添加股票自动进入全部 + 对应市场）；自定义分组才是显式归属。
- 分组图标走 `PUT /watch-groups/{id}` 的 `icon` 字段，同时注册素材库 `type=group`（`saveGroupAsset`，防文件清理丢失）；上传文件用 `POST /api/v1/watch-groups/{id}/icon`（multipart `file`），服务端校验所有者并以分组名称存入用户/分组独立目录；公共素材上传仍限管理员。
- 显隐 `visible`：`-1` 自动（空分组隐藏）/ `0` 隐藏 / `1` 显示；全部分组网格不受显隐影响。
- 筛选状态写入 URL `?filter=<分组id>`；兼容旧 `?filter=M:US` / `G:名称` 与 `?market=` 自动迁移；分组不存在自动回退「全部」。
- 旧 localStorage 配置（`fire:watch-groups:v1`）首次加载一次性迁移到服务端并清除（`migrateLegacyWatchGroups`）。
- 外部数据源地址（实时行情 / 搜索 / 分时走势 / 美股财报）统一从设置读取：`quoteApiUrl`、`searchApiUrl`、`chartApiUrl`、`earningsApiUrl`，不要硬编码到业务代码。
- 深色模式：所有颜色用主题类（`bg-white`、`text-ink`、`border-edge` 等），新增透明度变体时同步在 `app/globals.css` 补 `.dark` 覆盖。

## 按钮间距约定

- 区块/表单底部的主操作按钮（保存、提交、确认修改等）与上方内容间距统一为 16px：按钮本身加 `mt-4`，或所在容器用 `gap-4` / `flex-col gap-4`。
- 同一设置区块内多个底部按钮（如「测试连接 + 保存」）用 `mt-4 flex flex-wrap gap-3` 包裹，保持各区块一致。
- 弹窗底部操作区统一用 `mt-5 flex justify-end gap-2.5`（或 `border-t pt-4`），不要出现按钮紧贴上方表单的情况。

## 本地版 / 线上版发布约定（重要）

- 本地功能或修复完成后，同步提交并推送 `main`，让线上代码与本地保持一致；`push` 只运行检查，**禁止因为普通本地更新而自动触发手动 GHCR 发布**。
- **提交标题统一使用英文类型前缀 + 简明中文摘要**，因为「部署状态」页会直接显示 GitHub 提交标题。格式为 `类型: 中文摘要`，按改动性质选择 `feat:`、`fix:`、`style:`、`docs:`、`refactor:`、`test:`、`chore:`；使用半角冒号和一个空格，不使用 ` > `。摘要直接说明用户能感知的修改和结果，不使用生硬的自造词、职场黑话或比喻性动词。例如 `fix: 卡面库记住上次选择`、`style: 卡面详情去除重复 NEW 标记`。GitHub Actions 通过 `npm run check:commit-title` 检查每次推送包含的全部提交，格式错误时必须修正。
- 同一项需求中的连续界面微调尽量完成并确认后合并为一次提交和推送，减少 Actions 排队与取消记录；已经独立完成、需要用户及时查看的修改可以单独推送。
- 每次涉及 Web 代码、样式或配置的修改，提交前必须运行 `npx tsc --noEmit`，通过后再提交；不得用 `git diff --check` 代替类型检查。纯文档改动无需重复运行类型检查，但交付时必须如实写明实际执行的检查。
- 交付答复必须先用正常正文说明本次改了什么、为什么这样改、如何验证；有多个具体变化时使用简短项目符号逐项列出。**正文标题、类型检查结果和推送回执前禁止使用 Emoji。不得用推送回执代替修改明细，也不得为了压缩篇幅删掉用户需要的结果说明。** 正文之后再附两行引用回执：第一行固定为 `> 类型检查通过，已成功推送\`短提交号\``，“已成功推送”与提交号之间不留空格；第二行固定为 `> 类型: 简明说明本次更新内容。` 两行之间不空行，提交号前不加中文冒号，类型必须与提交标题一致。例如：`> 类型检查通过，已成功推送\`39936ff\`` 换行 `> docs: 统一提交标题与推送回执格式。` **交付答复不再输出 GitHub Actions 自动检查状态**；用户主动询问时再查询并单独回答。只有 `git push` 明确成功且本次确实通过 `npx tsc --noEmit` 后才能写“类型检查通过”；未运行或未通过时必须如实说明。
- GHCR 默认由 GitHub Actions 在**每天北京时间 00:07** 检查 `main` 最新提交；仅在存在尚未发布的新提交时生成镜像，并避开 Actions 整点调度高峰。
- 只有用户明确说“立即上线”、“立即发布”或“手动推送”时，才可触发 `workflow_dispatch`；“同步线上代码”、“线上版同步更新”默认仅指提交 + `git push origin main`，不等于立即发布镜像。
- 线上更新流程为：本地验证 → 提交 / push → push 检查通过 → 每日 00:07 检测并在有新提交时发布（或用户明确授权的手动发布）→ 群晖拉取镜像并重建容器。

## 交互与适配约定（原「苹果色块标准」已取消）

> 2026-08-08 起取消「苹果蓝（#0071e3）」全局配色规范，品牌色 / 按钮配色不再强制苹果蓝；以下与颜色无关的交互与适配约定继续生效：

- 焦点样式：点击/激活/聚焦一律**无轮廓、无光晕**（globals.css 已全局定义 `outline: none; box-shadow: none`），任何场景（含 Safari、macOS「键盘导航」开启）都不出现白框/白圈；新增按钮不要依赖浏览器默认 focus ring，不要给 `:focus-visible` 添加可见 ring。
- 深浅色都要适配：新增颜色透明度变体或 hover 背景时，同步在 `app/globals.css` 的 `.dark` 区补对应覆盖。
- 素材库图标（市场 / 股票 / 加密货币 / 贵金属）必须全局生效：`useAssetIcons` 已带 localStorage 缓存，刷新不得闪现默认图标；新增图标类型时沿用该缓存机制。
- **图标唯一性（重要）**：同一界面内导航 / 设置项图标语义必须唯一，禁止两个条目共用同一图标。新增导航或设置页签时，必须先在 `components/SettingsHeader.tsx` 的 `ICON_PATHS` 注册与页面 key 一致的专属图标；**禁止依赖 `SubNavIcon` 的 site 回退**（未注册的 key 会静默回退成「网站设置」的地球图标，造成图标重复——例如关于页曾与网站设置共用地球）。排查手段：新增图标后全站走查导航 / 设置侧栏，确保每个 key 都能在 `ICON_PATHS` 中找到且形状互不相同。

## 中性色按钮标准（浅灰边框 + 白色块状，2026-08-08 起）

- 全站主按钮 / 色块统一为「白底 + 浅灰边框 + 深色文字」：`border border-edge-strong bg-white text-ink-2`（深色模式 `dark:bg-[#1c1c1e] dark:text-white`）。
- hover 统一为**明显浅灰背景**（`hover:bg-brand-hover`，浅色 ≈ #e9ebee；深色模式 globals.css 已补 `.dark .hover\:bg-brand-hover:hover` 为 #262c37），文字保持深色、边框颜色不变。
- 动画：按钮带 `transition-all duration-200`，hover 轻微上浮 `hover:-translate-y-px` + 阴影，点击 `active:scale-[.97]`。
- 选中态（tab / 分页当前页 / 胶囊）：`bg-white text-ink-2 shadow-sm border border-edge-strong`（白底浅灰边框 + 阴影），不再使用任何蓝色选中块。
- **例外**：首页 3D 展示台与车型导入页的胶囊统一走「展示台胶囊标准」（见下一节），不用白底块状这套。

## 展示台胶囊标准（首页 + 车型导入页统一，2026-09-20 起）

- 标准抽在 `components/showcase/capsule.css`：胶囊元素加 `class="fire-cap"`，需要时叠加 `fire-cap-primary`（主操作）或 `fire-cap-danger`（危险操作）；尺寸 / 字号 / 内边距仍由各自的布局类决定，**不要**再给胶囊单独写底色、描边、hover / 选中态。
- 三态（取自首页音乐按钮）：**常态** = 极淡面板底 + 1px 细描边 + 背景模糊；**悬停** = 底色不变、只提亮描边与字色（铺灰底会让「松手后还像按着」）；**已开启 / 当前选中 / 主操作** = 玻璃渐变底 + 亮描边 + 极轻外发光；**按下** = 轻微收缩；只有 `:focus-visible` 画焦点环，鼠标点完不留圈。
- **浅色底分两个信号**：3D 舞台只认 `.showcase.light`（舞台自己的主题 / 影棚），车型导入页认 `:root:not(.dark)`。不要用 `html.dark` 判断舞台 ——「夜间隧道 + 浅色站点主题」会把胶囊套成 50% 白底（已踩过）。
- 胶囊一律 `flex: none` + `white-space: nowrap`：一排放不下时由外层横向滚动，禁止把文字挤成两行（导入页卡片上的五个胶囊在桌面宽度必须一行）。
- 危险操作（删除并删文件）沿用同一套几何与交互，只把色相换成红（`fire-cap-danger`）；首页那个橙色冲刺按钮是品牌主按钮，不在这套里。
- 覆盖范围：首页 HUD 的工具胶囊（音乐 / 深浅色）、左下角胶囊（环视 / 影棚 / ZOOM / 固定机位）、缩放按钮、右下角车型条与「＋」，以及车型导入页的全部按钮。

## 滚动条规范（全站统一，2026-09-13 起）

- 全站滚动条统一成「卡面库筛选面板」那种细条：`app/globals.css` 顶部已有全局规则（`*` + `*::-webkit-scrollbar`，4px、圆角、半透明灰，深色模式自动换成白色 26%），**新组件不要再自己写一套滚动条样式**，也不要再给容器加 `.thin-scrollbar`（该类名保留只为兼容，效果已全局）。
- 例外只有两种，都必须用**更具体的选择器**覆盖，不要改全局规则：
  - **隐藏**滚动条：横向滑动的胶囊行 / tab 用 `scrollbar-width: none` + `::-webkit-scrollbar { display: none }`（如 `.ticker-scroll`、`.stock-detail-tabs`）；
  - **特殊定制**：订单表、每日盈亏分享列表等自己有明确设计的地方（`.orders-scroll`、`.share-list-scroll`）保持各自样式。
- 备注：Chrome 121+ 只要元素上存在标准属性 `scrollbar-width` / `scrollbar-color`（包括全站 `*` 设的 thin），就会忽略 `::-webkit-scrollbar*`，改用内置「thin」档。要精确控制 Chrome 宽度，得把这两项重置为 `auto`（或用 `@supports not selector(::-webkit-scrollbar)` 把标准属性只留给 Firefox）。
- **「默认隐藏、悬停才显示」不要再写 `scrollbar-color:transparent`**（2026-09-19 踩过：左侧导航滚动条彻底消失）。Chrome 忽略 webkit 之后，透明的标准滚动条等于把条子关掉，划过也不出现。正确写法参考 `.fire-sidebar-panel`：
  - 必须带 `.dark` 前缀：全站 `.dark *` 与单写一个类特异性相同（都是 0-1-0）且位置更靠后，只写类名会在深色模式下被盖回去（2026-09-18 还踩过常显）。
  - Chrome / Safari：`.x,.dark .x{scrollbar-width:auto;scrollbar-color:auto}`，再用 `::-webkit-scrollbar-thumb` 默认透明、`:hover` / `:focus-within` 着色。
  - Firefox：放进 `@supports not selector(::-webkit-scrollbar)`，用 `scrollbar-color` 做同样的隐藏 / 悬停。

## 弹层 / 整屏视图必须 portal 到 body（2026-09-13 起）

- 所有 `fixed inset-0` 的弹层、抽屉、整屏视图（卡面详情、新增卡片、卡包等）**一律用 `createPortal(..., document.body)`**，不要直接挂在视图树里：祖先只要形成层叠上下文，弹层里写的 `z-[10002]` 也压不过吸顶页头（`z-50`），顶部会被页头盖掉（已踩过：卡面详情弹窗被遮、`rect.top` 实测是 16 而不是 0）。
- 弹层顶部要给页头留位置（`pt-[72px]`，sm 以上 `sm:pt-[88px]`），高度控制在 `86vh` 上下 —— 整块落在页头下方居中，既不压页头、也不被页头遮挡。
- 已 portal 的参考实现：`components/views/CardLibraryView.tsx`（详情 / 新增 / 卡包）、`components/AppModal.tsx`、`components/FundEntryDialog.tsx`、`components/DailyPnlShareModal.tsx`。新增弹层先抄这些，不要新开写法。
- 品牌色板已整体改为中性灰：`brand.DEFAULT=#6b7280`、`brand.hover=#e9ebee`、`brand.light=#f1f3f5`、`brand.deep=#3f4652`；旧苹果蓝 `#0071e3` 及蓝色阴影/焦点光环已全量清除（焦点光环改中性灰）。
- 新增按钮 / 色块一律遵循上述中性色标准，不再引入蓝色或彩色块状。

## 素材库文件命名规范（全局，重要）

- 所有素材文件按「中文名称 + 英文简称/代码」命名，禁止时间戳随机名：
  - 市场图标：`中文名+市场码`（美股US.svg / 新加坡SG.png）
  - 加密货币 / 贵金属：`中文名+代码`（比特币BTC.svg / 黄金GOLD.png）
  - 股票图标：`中文名+股票代码`（苹果AAPL.png / 寒武纪688256.png，与素材库同步一致）
  - 券商图标：`券商名称`（长桥证劵.png，对应「设置 → 股票设置 → 券商管理」中的券商分组），存放 `public/uploads/asset/broker/`
  - 分组图标：`分组名称`（科技.png，对应自选股自定义分组，非券商分组），存放 `public/uploads/asset/group/`，素材库「分组图标」分类与 `watch_groups.icon` 同步

## 资源本地化约定（重要）

- **线上版 / 线下版资源一律走本地素材库**，禁止依赖远程 CDN 图标（flagcdn / 长桥 LB 等）。图标、市场 / 货币旗帜、名人头像、导航图、登录图、site logo、背景等展示资源以 `public/uploads/` 的本地文件为准：镜像打包默认资源（`asset` / `celebs` / `currency` / `ico` / `login` / `logo` / `background`，不含用户 `avatar` / `reports` / 分组图标），首次启动由 `entrypoint.sh` 复制到 `./uploads` 挂载；素材库按类别用 `ensureIconAssets` / `ensureMarketAssets` / `ensureCategoryAssets` 播种缺失的默认条目（icon / market / crypto / metal），不覆盖用户已上传素材。
- 前端图标渲染：素材库自定义图标优先，加载失败 `SafeAssetImage` 回退内置矢量默认图标；市场图标 `MarketIcon` 无本地素材时回退本地矢量地球，**不再请求任何远程图标地址**。
- 新增任何可上传 / 可展示的图标时，同步确认本地素材存在 + 素材库播种逻辑 + `SafeAssetImage` 兜底，避免出现「?」破图。
- **上传文件一律经 `/uploads/[...path]` 动态路由服务**：`next start`（生产）只服务构建/启动时已存在的 `public` 文件，运行时上传到 `public/uploads/...` 的文件不会走静态服务（会 404）。上传内容必须能被该路由从磁盘读取返回（`Cache-Control: max-age=0, must-revalidate`），否则上传后立即无法访问。

## 股票 / ETF 名称规范（全局，重要）

- 杠杆 ETF 统一格式：`主体名称 + 空格 + N 倍做多 + 空格 + ETF`，如 `Rocket Lab 2 倍做多 ETF`、`苹果 2 倍做多 ETF`、`英伟达 2 倍做多 ETF`；倍数一律用中文「2 倍做多」（不写 `2x` / `2X` / `two times`），禁止「2倍做多2x」这类冗余重复。
- 中英文主体写法：英文主体保留英文（`Rocket Lab 2 倍做多 ETF`、`Tesla 2 倍做多 ETF`、`Robinhood 2 倍做多 ETF`），中文主体用中文（`苹果 2 倍做多 ETF`、`超微电脑 2 倍做多 ETF`）；主体与「2 倍做多 ETF」之间用全角空格分隔。
- 「ETF」统一大写；禁止无空格拼接与小写写法（如 `标普500etfvanguard`、`Spcx2倍做多2x etf`、`etf` 一律不允许）。
- 指数 / 商品 ETF：主体含指数或基金公司时用全角括号标注（如 `标普 500 ETF（Vanguard）`、`太空 ETF`），禁止把公司名直接拼进主体。
- 适用范围：`records.name`、`trade_orders.name`（成交时快照）与 `activities.stock_name`（操作日志）三处必须一致；修改任一股票名称时必须同步更新这三张表，避免订单 / 日志仍显示旧名。
- 新增 / 编辑股票时按上述格式命名；发现历史脏数据（冗余倍数、小写 etf、无空格拼接）时批量规范化并按三表同步。

## 券商（Broker）数据规范（Web + iOS / Android 统一）

- 券商 = 设置-股票设置-券商管理中的分组，模型：`{ id, name, alias, icon }`——`id` 为分组 ID（小写为规范）、`name` 为券商名称、`alias` 为别名（如 盈透证券 → IBKR，展示在名称下方小字，可选）、`icon` 为素材库券商图标本地 URL（无图标为空，客户端回退名称首字母）。
- 存储：券商列表在 `site_settings.groups`（顺序即展示顺序）；图标在 `assets`（type=broker，code=分组ID，name=券商名）；持仓记录 `records.group_name` 存券商名称。
- 同步：改名/删除券商后必须同步持仓记录（`lib/brokers.ts` 的 `syncRecordGroups`）；保存分组设置时同步素材库 broker 素材名称（`UPPER(code)=分组ID`）。
- 接口：v1 统一入口 `GET/POST/DELETE /api/v1/brokers`（详见 docs/api-spec.md「券商 Brokers」）；素材库 broker 素材 code 存库为大写，匹配一律大小写不敏感。
- 防误清：券商列表为空时保存必须二次确认（前端已实现），禁止用空列表覆盖非空券商。
- 券商数据只读基准：修改 `site_settings.groups` 必须基于**当前完整列表**增量操作（读取 → 增删改 → 全量写回），**禁止用硬编码列表覆盖**（曾因迁移脚本用 3 个硬编码券商覆盖，导致用户添加的 6 个券商分组丢失）；恢复时可从 `assets`（type=broker，code=分组ID）与 `records.group_name` 反推被删分组。

## 相关 ETF 与正股双向关系 / 图标规范

- 正股详情显示「相关 ETF」；已收录 ETF 的详情页反向显示「正股」，两边均从 `lib/relatedEtfs.ts` 的 `US_RELATED_ETFS` / `RELATED_ETF_MAIN_STOCK` 单一关系源派生，禁止在组件或图标模块另写一份关系清单。
- 所有已映射的相关 ETF 固定使用**正股股票图标**（不以 ETF 是否已有自有图标为条件），覆盖常见交易所后缀（.AM / .N / .OQ / .PS / .K），通过 `useAssetIcons.stockIcons` 在全站（个股详情 / 自选股 / 我的持仓 / 素材库 / 名人持仓）生效；主体图标缺失时才回退名称首字母。
- 历史 2X 产品（RKLX / SPCH / MSTU / SSO / QLD / SPUU）也必须进入 `US_RELATED_ETFS`；禁止另建仅供图标使用的平行映射。美股代码匹配需兼容 `.AM` / `.N` / `.OQ` / `.PS` / `.K` 交易所后缀，确保列表代码与详情反向正股一致。

## 行情数据源注意事项

- 腾讯行情接口（qt.gtimg.cn）**批量查询已失效**：每次请求只返回第一条记录，所有行情批量调用（fetchQuotes / 财报图标价 / 迷你走势）必须**逐条请求 + 并发限制**（lib/quotes.ts fetchBatch 已实现并发 6）；任何新增行情拉取逻辑禁止批量拼接，回填脚本 scripts/backfill-quotes.mjs 同样逐条。
- 富途快照接口（`get_market_snapshot`）**整批一起返回**：只要批量里有一只不被支持的代码（典型是美股 OTC，如 `SFTBY` 软银 ADR，报错「暂不提供美股 OTC 市场行情」），整批都会失败 —— 曾导致全部美股拿不到富途行情、退回腾讯常规盘口径，**当日盈亏一整天冻结在上一交易日**。scripts/futu_quotes.py 的 `_market_snapshot` 已做容错（剔除报错点名的代码重试 → 二分定位 → 其余正常返回，不支持的记入 `skipped` 走兜底源）；**任何新增的富途批量调用都必须沿用这套容错**，禁止再用「一次拿不到就整批放弃」的写法。
- 美股扩展时段（盘前 / 盘后 / 夜盘）只能靠富途或 Yahoo：腾讯只给常规盘口径（涨跌停在上一交易日收盘）。Yahoo 在境内直连不稳定，lib/usExtendedQuote.ts 已加 60 秒熔断（双主机都失败即快速失败，避免整批 6 秒超时拖到十几秒）；**降级到腾讯时界面必须能看出来**（components/QuoteSourceBadge.tsx 的「美股·腾讯兜底」胶囊），不要出现「数值不动但毫无提示」。
- 境外数据源（Yahoo / CoinGecko / SEC 等）统一走 `lib/net.ts` 的 `proxyFetch`，由 `STOCKLOG_PROXY` 控制（`off` 显式关闭）；**代理分支必须用 undici 包自己的 fetch**（`import { fetch as undiciFetch } from "undici"`）配合 `ProxyAgent` —— Node 自带的全局 fetch 与 npm 安装的 undici 不是同一份实现，把后者的 ProxyAgent 当 dispatcher 传给全局 fetch 会报 `invalid onRequestStart method (UND_ERR_INVALID_ARG)` 并静默回退直连（曾导致「配了代理仍然取不到 Yahoo 扩展行情」）。腾讯 / 新浪 / 东财等境内源保持直连，不要套代理。
- **no_proxy：内网地址永不发往代理**。`proxyFetch` 会先判断目标地址，命中「内置私网 / 回环 / 链路本地 / CGNAT / `.local`」或 `NO_PROXY` / `no_proxy` 环境变量（支持 `*`、域名后缀、IPv4 与 `IPv4/掩码`）即直接直连（富途 OpenD、NAS 接口、体检探针等都在此列）。注意 Node 的 fetch **不读** http_proxy / https_proxy / no_proxy 环境变量（只有 curl / python / npm 这类工具才读），所以容器里那套 `*_proxy` 变量对本应用无效，代理必须靠 `STOCKLOG_PROXY` + `proxyFetch`；排查时用 `STOCKLOG_PROXY_DEBUG=1` 打印每条请求走代理还是直连。
- 日股 / 韩股现价：腾讯前缀 `jp{code}`（去 .T）/ `kr{code}`（去 .KS/.KQ），`lib/quotes.ts` 的 `toTencentSymbol` / 分时查询与素材库回填脚本共用；自选股 / 持仓实时行情已覆盖 JP/KR。台股 / 新加坡 / 英德法 / 澳加 / 印度 / 巴西暂无可用源，界面显示「暂不支持实时行情」，不要留空白假装有价。
- 富途 OpenD 免费额度同一时间只允许 1 个连接。生产容器按设置连接；本地 `next dev` 默认跳过（`STOCKLOG_FUTU=on` 可开启，`off` 则任何环境都不连），避免抢线上唯一槽位。设置页「测试连接」仍会真实打 OpenD。
- 手动添加的美股 ETF（VOO / IVV / VTI / TLT）东财不返回市值（基金规模），如需要市值按公开净资产近似填写并注明；BRK.B 用东财 secid `106.BRK_B`（下划线）、DJT `105.DJT`、北交所 `0.{code}`。

## 个股详情交互规范（重要）

- **前端（首页 / 门户）**：个股点击一律使用**弹窗**（`StockDetailView`，moomoo 风格：头部行情 + 指标延伸 + 概览/期权/财务/公司 tab + 双引擎 K 线），不改页面地址。
- **后端（自选股 / 我的持仓 / 行情板等管理视图）**：个股点击一律**无感进入详情视图**——当前视图内容平滑过渡为详情页（fade 过渡、不整页刷新），左上角「返回」回到列表，并同步 URL（如 `?symbol=US:AAPL`，刷新 / 前进后退保持），禁止用弹窗承载后端详情。
- **持仓交易入口**：我的持仓一级页只展示组合和编辑 / 删除，不放买入、卖出或订单标签；点击股票进入二级个股详情后，统一通过「交易」按钮选择买入 / 卖出，并在同页查看该股票今日 / 历史订单。
- **订单与持仓**：订单是不可变成交凭证，持仓是最新快照；成交写订单与更新数量 / 成本必须在同一数据库事务内完成，禁止超卖。买入成本包含费用并加权，卖出记录扣除费用后的已实现盈亏。
- 详情头部与指标必须使用真实行情（`Quote` 的 volume / amount / pe / turnover / marketCap 字段）；盘后行情行无数据源时不展示。
- 持仓数值校验：现价与数量禁止负数；成本价允许负数，用于返佣、期权收入或累计回款超过投入后的负成本场景。普通 records 接口与 v1 records 接口必须保持一致并返回准确字段提示。
- 候选去重：素材库「新增主流券商」候选（MAIN_BROKERS）中同一券商只保留一个规范名，其他写法 / 英文名放 `aliases`（如 IBKR = 盈透证券、Schwab = 嘉信理财、Webull = 微牛证券）；添加与 ✓ 置灰判断必须同时比对规范名 + 别名，并做「证劵/证券」归一化（`brokerNameKey`）。新增候选时先检查全表，禁止同一券商以不同名称重复列出。
- 命名由服务端 `lib/upload.ts` 的 `assetFilename` 统一生成（读上传表单的 name / code / market），前端上传时 FormData 必须带这三个字段；URL 用 `encodeURIComponent` 存库。
- 存量文件命名迁移 / 规范化一律使用项目内工具 `scripts/rename-assets.mjs`（`node scripts/rename-assets.mjs [--dry-run]`）：只重命名不删除、URL 先 `decodeURIComponent`、路径前缀 `/uploads/...`，并自动同步 `assets.url` / `assets.name`；不要手写遍历脚本改素材文件名。
- 文件分类存放：`public/uploads/asset/{market|crypto|metal|stock/{市场}}/`，禁止散落到 `uploads/asset` 根目录；出现根目录残留时按本规范迁移并更新 `assets.url`。
- 素材库市场图标同步维护：新增市场必须同时补 `MARKET_META`（lib/types.ts，含 label/currency/flag）、`MARKET_CURRENCY`（lib/useRates.ts）、`FALLBACK_RATES` 与服务端 `/api/rates` 拉取币种，否则市值会按 1:1 误算成美元。

## 头像命名规范

- 用户头像文件按「登录名(UID编号)」命名（如 `admin(UID1).png`，括号内为 `UID` + 数字，无冒号/横线分隔），由 `lib/upload.ts` 的 avatar 分支统一生成；新用户上传延续此命名，禁止时间戳随机名。
- 头像重命名 / 清理时同步更新 `users.avatar`，并通过 `removeFileIfUnused` 清理旧文件（保留其他引用）。

## 素材清理注意事项（防止误删）

- 清理孤立文件必须用项目内 `lib/fileCleanup.ts` 的 `cleanupOrphanFiles`（内部已做 URL 解码 `safeDecode` + `PUBLIC_DIR` 相对路径比对），**不要**手写遍历脚本。
- 手写文件操作脚本时，URL 与磁盘路径对比必须先 `decodeURIComponent`，且相对路径前缀必须为 `/uploads/...`（不是 `/public/uploads/...`）。
- 素材上传 / 删除后，`assets.url` 必须与磁盘文件名一致（统一 encodeURIComponent 存库）；出现不一致时按「素材库文件命名规范」迁移并同步更新记录。

## 货币换算规范

- 素材库 / 资产总览等所有市值展示统一换算为美元：`usdCap(market, cap, rates) = cap ÷ rates[MARKET_CURRENCY[market]]`。
- 新增市场（如新加坡 / 英国 / 德国 / 法国 / 澳大利亚 / 加拿大 / 印度 / 台湾 / 巴西）必须同步：`MARKET_CURRENCY` 映射市场→货币、`FALLBACK_RATES` 补兜底汇率。实时汇率只走设置里的 `currencyApiUrl`，接口没返回的币种在汇率换算页显示「暂无汇率」，不要再为单个币种接腾讯外汇。
- 此问题已两次出现（港股 / A股早期、全球市场新增时），后续新增任何市场类型必须按此检查清单执行。

## 苹果风格开关（Toggle）标准（重要）

- **「苹果风格」的基准 = 名人持仓 → 名人管理中的启用开关**；此后用户说「苹果风格」（开关类）一律指该样式。
- 外观规范：
  - 开启：轨道苹果绿 `#34c759`，圆点纯白
  - 关闭：轨道浅灰 `#e9e9ea`（深色模式 `#3a3a3c`）
  - 圆点：必须纯白，且用**内联样式** `style={{ backgroundColor: "#fff" }}`，禁止用 `bg-white` 类——全局暗黑规则 `.dark .bg-white` 会把圆点覆盖成深色（#151a26）
  - 阴影：圆点加 `shadow`（`0 1px 3px rgba(0,0,0,.25)` 量级）
  - 过渡：300ms，iOS 缓动 `cubic-bezier(.32,.72,0,1)`（通过内联 `transitionTimingFunction` 或对应 easing 类）
  - 尺寸基准：36×20（名人管理标准），圆点 16，横向位移约 18px
- 动画规范（与名人管理开关一致）：
  - 轨道颜色过渡：300ms，`transition-colors duration-300 ease-out`
  - 圆点滑动：300ms，缓动 `cubic-bezier(.32,.72,0,1)`（iOS 开关专用曲线，内联 `transitionTimingFunction`），从关闭位平滑滑到开启位，无跳变、无卡顿
  - 点击响应：状态切换乐观更新（立即翻转、后台保存），失败回滚并提示；切换时页面整体无抖动、不重挂载
  - 禁止给开关添加额外的弹跳 / 缩放 / 闪烁动画，保持与系统级开关一致的克制感
- 适用场景：全站所有开关类控件（启用 / 停用、CDN 图标通道、允许新用户注册、自动备份等）统一使用该风格，不得混用其他轨道色或圆点写法。
- 深浅色模式都要一致：圆点纯白、开启苹果绿、关闭浅灰/深灰。

## 名人持仓版本标记（重要）

- **名人持仓 F1** = 本次“额头置顶于扇形之上”改造前的版本，完整备份在 `docs/celebs-ring/celebs-ring-F1.tsx`（即当时的 `components/views/CelebsView.tsx` 全文）。
- **名人持仓 F2** = 头像置顶于扇形之上（圆环统一渲染在人物之下，悬停弹出块状从头像后面穿过、不覆盖人物），完整备份在 `docs/celebs-ring/celebs-ring-F2.tsx`（已更新至含收益曲线 / 悬停优化等全部新功能的快照）。
- **名人持仓 F3** = F1 下半身 + F2 上半身融合版（头像融合，含原始 path 事件悬停）：透明头像拆成双层——下层（圆环之下）只显示身体下半部分，领带下方被圆环环带遮挡（F1 效果）；上层（圆环之上）只显示头部上半部分，额头从洞里探出、压住上方扇形（F2 效果）。头像尺寸 0.74、上移 6px（悬停 8px）；上层 mask `#000 0-50% → rgba(.8) 54% → rgba(.3) 58% → transparent 62%`，下层 mask `transparent 40% → rgba(.4) 50% → #000 58% → #000 100%`。完整备份在 `docs/celebs-ring/celebs-ring-F3.tsx`。
- **名人持仓 F4** = 当前版本（F3 融合版头像 + 扇区悬停修复）：头像层全部 `pointer-events-none`（不再遮挡环带内缘），扇区 hover 改为容器级几何判定——鼠标在环带任意位置（含基础环露出的细线区）按角度映射到对应扇区，头像上浮由容器统一判定（鼠标在中心洞里触发）。完整备份在 `docs/celebs-ring/celebs-ring-F4.tsx`。
- 用户说「恢复至名人持仓 F1 版本」时：用 `docs/celebs-ring/celebs-ring-F1.tsx` 整体替换 `components/views/CelebsView.tsx` 即可（该文件是当时的完整快照，含 CelebRing / 头像渲染 / 圆环逻辑）。
- 用户说「恢复至名人持仓 F2 版本」时：用 `docs/celebs-ring/celebs-ring-F2.tsx` 整体替换 `components/views/CelebsView.tsx`。
- 用户说「恢复至名人持仓 F3 版本」时：用 `docs/celebs-ring/celebs-ring-F3.tsx` 整体替换 `components/views/CelebsView.tsx`。
- 用户说「恢复至名人持仓 F4 版本」时：用 `docs/celebs-ring/celebs-ring-F4.tsx` 整体替换 `components/views/CelebsView.tsx`。
- 后续每次重要改造前，先在 `docs/celebs-ring/` 备份当前 `CelebsView.tsx` 并编号（F1、F2…），并在 AGENTS.md 此节登记新版本含义，便于随时恢复。

## 货币显示规范（重要）

- 金额一律「符号在前」：美股 `$7.31`、港股 `HK$173.00`、A股 `¥12.50`（`MARKET_META.currency` 为前导符号）。
- **各市场盈利卡片右上角的币种标识固定为规范形式，未经用户指示不可更改**：美股 `USD$`、港股 `HKD$`、A股 `CNY¥`、日股 `JPY¥`、韩股 `KRW₩`（`MARKET_META.code` 字段）。禁止把该处改成前导符号或去掉代码。
- 总资产货币切换显示用符号：`$` / `¥` / `HK$`。

## 技术栈登记约定（重要）

- **每次引入新的框架 / 技术栈 / 外部依赖 / 数据源时，必须同步更新「设置 → 关于」页面的对应清单**（前端框架、后端与数据、外部数据源、架构特性等卡片）。
- 涉及的关键位置：`components/views/SettingsView.tsx` 中 `sub === "about"` 渲染块内的列表数据。
- 引入新依赖（如 npm 包）时，同时确认其在「关于」页面有对应条目；未使用的依赖不在页面展示（如仅测试）。

## 版本记录约定（重要）

- **网站每一次更新（新功能、漏洞修复、安全加固、界面变动、技术栈变动）都必须写入版本记录**，禁止只改代码不记版本。
- 版本记录单一数据源：`lib/versions.ts`（类型 + 当前版本条目 `CURRENT_VERSION_ENTRY` + `CURRENT_VERSION` + 全量历史数组 `VERSIONS`，**版本记录只维护这一个文件**）。设置 → 关于 → 版本弹窗展示的内容全部来自它；同时同步一份人工可读日志到仓库根目录 `VERSIONS.md`。
- 每次更新完成后：
  1. **版本以「日」为判断标准**：同一天内的多次更新合并进当天版本号，不单独递增；跨过凌晨（新的一天）后的首次更新才开启新的版本号（v0.1.0 → v0.1.1 → v0.1.2 ...）。
  2. 今天已有版本条目 → 把新变更追加到 `lib/versions.ts` 的 `CURRENT_VERSION_ENTRY.changes`；跨天 → 把旧 `CURRENT_VERSION_ENTRY` 整体移入同文件 `VERSIONS` 数组头部（替换其中 `CURRENT_VERSION_ENTRY` 占位引用），再写入新的当前版本条目（`CURRENT_VERSION_ENTRY` 即当前版本）；
  3. 变更按类型标记：`feature`（新功能）/ `fix`（修复）/ `security`（安全）；
  4. 弹窗内「前端版本 / 软件版本 / 新功能」三个分区内容保持齐全，软件版本号与当前条目一致；
  5. 同步更新 `VERSIONS.md` 对应章节（新功能 / 修复 / 安全修复 / 界面与规范）。
- 版本弹窗（`components/VersionModal.tsx`）在未来多版本时自动展示顶部版本切换胶囊，维护时无需额外改动。


## 全站审查回归（2026-09-14）

- `npm run test:review` 在临时数据库验证设置脱敏、导入隔离、币种换算、刷新时钟、用户分组图标权限和版本完整性，不写真实用户数据。
- 首次行情、手动刷新与定时轮询分开处理；后台回到前台只有到期才补轮询，首次尚未取得行情除外。
- 行情板默认 5 个分组（含全部），宽度随内容，圆形更多紧邻第五个；四个操作（包括置顶）默认隐藏，鼠标经过才显示。
- 导入界面在手机宽度必须可滚动到取消/导入；添加分组仍位于分组列表底部。
- 设置字段下发走白名单；普通用户和管理员均不直接收到密钥。导入只按明确市场和代码匹配，歧义停止并回滚，不猜测覆盖持仓。
