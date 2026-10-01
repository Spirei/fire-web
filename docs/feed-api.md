# Alcor 动态 · Web / iOS 合同

展示名改为「动态」，保留导航键 `trading`、`/trading` 地址和旧公开内容数据/接口。只重塑动态页与居中上方的小人，不搬 Muse 的其他模块。3D 图标只在动态页实际渲染时请求。

## 权限与发现

所有端点使用现有 `{code,message,data}` 信封，账号数据 `no-store, private`。Web 用本人 Cookie 与同源保护；App 使用现有 PKCE Bearer grant。

- `feed.read`：本人动态、指示、任务、讨论。
- `feed.write`：修改指示、生成、喜欢/隐藏、讨论，必须同时申请 `feed.read`。
- 默认/旧 grant 不扩权；App 重新通过网页明确同意取得权限，`portfolio.write` 不能代替动态权限。
- `/api/v1/auth/config` 增加 `feed_path,feed_scopes`；`auth/me.capabilities` 增加实际 `feedRead,feedWrite`。跨账号资源统一 404，不接受 `userId`。

## 端点

| 方法 | 路径 | 请求 / 返回 |
| --- | --- | --- |
| GET | `/api/v1/feed?limit=10&cursor=…` | `FeedPayload`；默认10条，limit 1–50，新闻按创建时间、名人按原帖时间 / id 降序游标 |
| PUT | `/api/v1/feed/preferences` | `{instructions,revision,enabled?,intervalMinutes?}` → `FeedPreferences` |
| POST | `/api/v1/feed/refresh` | `{}` → 持久化 `FeedJob`；后台执行 |
| GET | `/api/v1/feed/jobs/{id}` | 本人 `FeedJob` |
| GET | `/api/v1/feed/posts/{id}` | 本人 `FeedPost`，包括隐藏状态 |
| PUT | `/api/v1/feed/posts/{id}` | `{liked?:boolean,hidden?:boolean}` → `FeedPost`；false 撤销 |
| GET | `/api/v1/feed/posts/{id}/discussion` | `{messages:[…]}`，最近 40 条正序 |
| POST | `/api/v1/feed/posts/{id}/discussion` | `{text}`，1–2000 字 → `{messages:[…]}`；失败不保存半个回合 |

唯一字段类型是 `lib/feedTypes.ts`。时间统一 UTC ISO 8601，`publishedAt` 来自来源发稿时间，未知 null；`createdAt` 是生成时间。Web正文底部不显示发稿日期；来源选项仍保留，App字段兼容不变。帖子 id `fp-` + 24 位 hex，任务 `fj-`，消息 `fm-`。

`FeedPayload` 含 `posts,nextCursor,preferences,job,capabilities`。帖子含 `title,icon,segments,sources,media,publishedAt,createdAt,liked,hidden`。`segments[].sourceId` 是事实引用，不等于整段可点击；新增可选 `linkText` 仅指定 `text` 中的一处原样关键短语。Web 与 App 应只将该短语标蓝可点，其余文字保持正文色，不解析模型 HTML。每帖最多2处，每处2–32字、总长度不超过正文35%；服务端和 Web 均校验，超限降为普通文字、仍保留引用。无 `linkText` 的旧帖子正文保持普通文字，Web 最多链接开头的短媒体署名；原文和引用保留在来源选项里，不改旧数据。旧 App 忽略新字段不会崩溃，但要改为此呈现逻辑才能去掉整段链接。共享规则见 `lib/feedPresentation.ts`。图标为 `/uploads/feature/feed/{icon}.webp`。媒体只预留经校验资源；没有实际素材返回 `[]`，不能用模型生成 URL 伪造图片。

指示最多 4000 字，`revision` 必填并做 CAS，旧版本 40901。修改只影响未来动态，历史不替换；同时取消旧版本任务。Web 只有右上角一个模板与指示编辑入口，更新开关和间隔仅在此编辑弹窗内配置；新闻模板保存非空指示后启用服务端静默生成，清空则停止。旧 App 的 `enabled`、`intervalMinutes` 参数仍兼容，既有偏好不批量覆盖。默认内部间隔 360 分钟，可设 60–1440；生产容器自动执行，开发默认关闭；本地需要自动更新时显式设置 `FIRE_FEED_SCHEDULER=1` 并重启开发服务。失败任务15分钟后重试（从失败结束时间计算），成功仍按保存的间隔更新。

任务状态 `queued/searching/writing/done/error`，同账号唯一活动任务，多 worker 数据库原子认领，全站最多 8 个活动任务。运行任务每30秒续期；进程中断超过5分钟由后台恢复error，不必等正常更新间隔。单次生成总预算4分钟，超时保留历史。生成不依赖网页保持打开。Web 当前动态页在前台每分钟静默读取结果，首屏和“查看更早动态”每页10条，静默同步保留本页已展开范围；已知活动任务每 2.5 秒只查状态；返回前台、缓存页面或 bfcache 恢复时合并过期读取。轮询只读，不触发付费生成；离开/后台不轮询。后台失败保留现有内容，不插入模拟新闻、不用更新横幅打断阅读；详情在上方小人任务弹窗，明确点按的操作失败仍可见。App 沿用任务和读取接口。

`capabilities.generate` 表示模型可用；旧 `search` 保持 `brave/news-rss` 枚举，表示兼容检索源。新增可选 `searchProvider=deepseek|brave|news-rss` 表示优先检索能力；旧 App 忽略新增字段即可，不能据此假定每次检索成功。小人原始眨眼、转头循环视频已本地化：`avatar.video=/uploads/feature/feed/alcor-idle.mp4`（H.264、480×480、24fps、约5秒、358KB，无音轨），`avatar.image` 为本地静态回退。只在上传卷或镜像默认资源存在时返回视频地址，否则 null。App 使用静音循环、前后台暂停、减少动态时静态、加载成功 500ms 淡入，不用 CSS 晃动图片代替表情。

## 搜索与安全

提炼、讨论复用「设置 → 模型服务」。使用官方 DeepSeek 且地址来源是 `https://api.deepseek.com` 时，同一密钥接入原生联网搜索：固定 `POST /anthropic/v1/messages`，启用 `web_search_20250305`，不把普通 Chat Completions 当成联网搜索。实现依据 [DeepSeek 官方搜索实现](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/web/web-search-deepseek)。只解析 `web_search_tool_result` 中的来源与 URL 对应的引用摘录；正文中的模型自造链接、日期与媒体不作为检索结果。网关密钥不转发给官方域名；不擅自推断网关的搜索地址。

原生检索失败时尝试服务端可选 `BRAVE_SEARCH_API_KEY`，失败再使用 Google News RSS；Brave 参数依据[官方文档](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)。原生来源没有日期时并行检索同话题 RSS，将带日期的报道作为独立来源补充，不能把其他文章的日期贴到原链接上。多话题来源轮流取样，防止第一个宽泛话题挤掉美股/公司事件。模型优先相关、带发稿日期的材料；日期未知仍为 null，摘要不等于文章全文，不宣称覆盖全网每个网站或市值前 100 的每家公司。

最多6条短检索词（最多2条公开财报线索与4条兴趣话题）、36个来源、8条动态；原生联网每话题1次工具调用、3000输出tokens、45秒超时，最多6话题分两批并发，RSS/Brave单次12秒，规划、编辑、证据复核各单次35秒、6500输出tokens，格式无效或截断仅重试一次；官方DeepSeek启用 [JSON输出](https://api-docs.deepseek.com/guides/json_mode/)，讨论仍为纯文本。模型调用与搜索均沿用服务端出站代理配置。官方 DeepSeek 的结构化提炼关闭默认思考，避免有限 token 全花在推理而没有 JSON 正文；依据[官方思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/)，不向其他兼容服务加专属参数。搜索固定主机、禁跳转，正文/响应体/分页有上限。来源只允许公网 HTTPS；拒绝明显邮件、地址、密钥型检索词。错误区分零结果与服务不可用；日志仅记录提供方、状态码和错误类别，用量审计不记录兴趣、密钥或上游正文。兴趣指示会传给管理员配置的模型，请不要填写秘密。

## 动态编辑技能

`lib/skills/alcor-feed-editor/SKILL.md` 是真正由服务端加载的技能包，不只是说明文档。规划、原生搜索、编辑和独立证据复核分别读取共享约束及本阶段规则；Docker现有lib复制链同时携带技能，文件缺失时安全报错，不悄悄退回旧提示。可见 Muse 的规律用于新闻编辑层：明确事件、关键细节、规模/反差和限制，少量事实短语链接；没有材料不凑数，不承诺复刻其不可见搜索系统。

美股兴趣读取近7天更新的公开财报日历，回查纽约日期最近3天并跨月，选取最多8家大公司作为线索；最多2家最高规模公司保留独立检索词，避免宽泛话题漏掉已知财报。日历只说明该查谁，不提供已发布业绩、数字或市场反应；缺失、过期或损坏时仍独立检索。不读持仓或私人数据，不写公共缓存。原生来源同一URL的多处引用摘要合并保留，避免只留下第一句。

编辑后再核对草稿与同批来源，重点去掉无依据数字、错误季度、预期冒充实际及盘后反应；复核来源限定在草稿已引用的集合，不引入新URL。复核失败保留历史，不能把草稿直接发布。模型复核仍不是事实正确或全网无漏报的保证；来源信息不足时应少发或不发，不能用“据报道”掩饰。

每账号生成 6 次/小时、讨论 20 次/小时，SQLite 共享全站预算。异步读取正文及讨论上游返回后重新鉴权，断开连接不能继续写入。错误不泄露内部诊断；用量审计不保存正文或密钥。`node tests/feed.cjs` 在临时数据库与模拟网络验证，不修改真实账号。

## 名人原帖模板（2026-10-02）

模板是组的显式配置，不从「名人动态」名称或提示词推断。现有组在右上角编辑中切换为「名人原帖」，新建组也可直接选择。只有两个内置模板：新闻 `mode="news"` 和原帖 `mode="people"`；不引入通用模板引擎。当前人物固定为特朗普 `trump`（Truth Social 原帖归档）和段永平 `duan`（雪球）。复用原交易广场采集器及公共缓存，不增加新来源。

- `POST /api/v1/feed/groups`：`{name,mode?,people?}`；`GET /groups` 返回本人组。默认 `news`，`people` 必须至少选一位，默认两位。
- `PUT /api/v1/feed/preferences?group={id}`：现有字段外可传 `name,mode,people`，同一 `revision` 原子保存。名人模板默认启用、每5分钟，允许5–1440分钟；无需 `instructions`、RSS 或新闻模型。关闭后停止定时采集，手动刷新仍可用。
- `GET /api/v1/feed?group={id}&author=trump`：人物筛选在服务端执行，游标覆盖完整历史。省略 `author` 为已选人物的全部原帖。v2 使用相同字段与行为，不扩大已有权限。
- `FeedGroup` 可选新增 `mode,people`；`FeedPayload.peopleSources` 含人物、上次尝试、上次成功和安全错误。`capabilities.generate` 继续只表示新闻与讨论模型可用，名人刷新不能据此禁用。
- `FeedPost.original` 含人物身份、平台帖子 ID、完整原文、可选中文译文、原文地址、回复与转发内容。`publishedAt` 为平台原帖时间，`createdAt` 为首次导入时间，阅读顺序使用前者。旧 App 可忽略新增字段继续读兼容正文与来源；要展示原帖卡和人物筛选需支持这些字段。

平台身份与正文由采集器取得，模型只负责忠实翻译，不能决定人物、原文地址、图片或时间。原帖先存，翻译之后更新同一 ID，不影响喜欢、隐藏或时间。图片只展示上传卷中实际存在的白名单本地文件；缺图仍保留图片帖和原文链接，挂载恢复后补回。模板切换不会删除任何新闻或原帖历史，只切换当前展示范围。

来源刷新共享正在执行的请求，60秒内不重复采集；名人手动刷新每账号30次/小时并受全站预算限制。后台调度无需模型配置，失败按不超过15分钟或该组更短间隔重试。来源失败不刷新「上次成功」或伪造新帖，保留已保存内容；诊断仅在点击小人打开的任务详情内显示，信息流不插提示。雪球返回登录验证失败时在任务详情提示更新设置中的 Cookie。Trump 翻译也沿用出站代理；长正文不使用只翻译前半段的兜底，截断响应不保存。上线沿用现有 `data`、`public/uploads` 卷与设置中的雪球 Cookie；镜像不会携带运行时缓存或 Cookie。`node tests/feed-people.cjs` 用临时 SQLite、缓存、图片和模拟网络验证模板、去重、分页、翻译更新、调度与失败保留。

## 人物头像与更新标记（2026-10-02）

`peopleCatalog` 返回两位固定人物及当前共享头像（上传映射优先，复用名人持仓原头像）；`peopleLatestAt` 返回已选人物全部可见历史中的最新原帖时间，即使本页按人物筛选或只显示10条，也包含其他已选人物的最新时间。客户端按个人阅读基线判断头像蓝点，首次进入建立基线，点击人物后消除该人物的更新点；来源请求成功时间不作为新帖依据。

徽标组件复用旧交易广场矢量，固定人物白名单：`trump` 粉色 Truth Social、`duan` 蓝色雪球，其他 ID 不绘制徽标，不由提示词、上游正文或头像上传指定。

管理员在「动态模板与指示 → 关注人物」点击头像选择图片，通过既有 `POST /api/celebs/avatar` 保存；上传独立于组名称、关注范围的保存，即时同步其他已打开的名人视图和历史原帖卡。图片限制 JPG/PNG/GIF/WEBP、2 MiB、内容校验、同源写请求，并在异步读取后重新验证身份。头像保存在现有 uploads/data 卷，不写浏览器临时地址或提交运行素材。`capabilities.editPeopleAvatars` 仅为 Web 管理员返回 true，普通账号和 App 不取得头像写权限。

- 名人动态的已读时间在对应人物原帖读取成功并显示后立即持久化；读取失败不提前清除头像更新圆点。已读时间合并只向前推进，保护其他标签页的较新阅读记录。人物切换遇到未完成的点赞/保存时，在写入完成后恢复读取，继续用请求序号排除迟到响应。
