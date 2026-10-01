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
| GET | `/api/v1/feed?limit=10&cursor=…` | `FeedPayload`；默认10条，limit 1–50，创建时间/id 降序游标 |
| PUT | `/api/v1/feed/preferences` | `{instructions,revision,enabled?,intervalMinutes?}` → `FeedPreferences` |
| POST | `/api/v1/feed/refresh` | `{}` → 持久化 `FeedJob`；后台执行 |
| GET | `/api/v1/feed/jobs/{id}` | 本人 `FeedJob` |
| GET | `/api/v1/feed/posts/{id}` | 本人 `FeedPost`，包括隐藏状态 |
| PUT | `/api/v1/feed/posts/{id}` | `{liked?:boolean,hidden?:boolean}` → `FeedPost`；false 撤销 |
| GET | `/api/v1/feed/posts/{id}/discussion` | `{messages:[…]}`，最近 40 条正序 |
| POST | `/api/v1/feed/posts/{id}/discussion` | `{text}`，1–2000 字 → `{messages:[…]}`；失败不保存半个回合 |

唯一字段类型是 `lib/feedTypes.ts`。时间统一 UTC ISO 8601，`publishedAt` 来自来源发稿时间，未知 null；`createdAt` 是生成时间。Web正文底部不显示发稿日期；来源选项仍保留，App字段兼容不变。帖子 id `fp-` + 24 位 hex，任务 `fj-`，消息 `fm-`。

`FeedPayload` 含 `posts,nextCursor,preferences,job,capabilities`。帖子含 `title,icon,segments,sources,media,publishedAt,createdAt,liked,hidden`。`segments[].sourceId` 是事实引用，不等于整段可点击；新增可选 `linkText` 仅指定 `text` 中的一处原样关键短语。Web 与 App 应只将该短语标蓝可点，其余文字保持正文色，不解析模型 HTML。每帖最多2处，每处2–32字、总长度不超过正文35%；服务端和 Web 均校验，超限降为普通文字、仍保留引用。无 `linkText` 的旧帖子正文保持普通文字，Web 最多链接开头的短媒体署名；原文和引用保留在来源选项里，不改旧数据。旧 App 忽略新字段不会崩溃，但要改为此呈现逻辑才能去掉整段链接。共享规则见 `lib/feedPresentation.ts`。图标为 `/uploads/feature/feed/{icon}.webp`。媒体只预留经校验资源；没有实际素材返回 `[]`，不能用模型生成 URL 伪造图片。

指示最多 4000 字，`revision` 必填并做 CAS，旧版本 40901。修改只影响未来动态，历史不替换；同时取消旧版本任务。Web 只有右上角一个编辑入口，不展示周期开关或时间表；保存非空指示后启用服务端静默生成，清空则停止。旧 App 的 `enabled`、`intervalMinutes` 参数仍兼容，既有偏好不批量覆盖。默认内部间隔 360 分钟，可设 60–1440；生产容器自动执行，开发默认关闭；本地需要自动更新时显式设置 `FIRE_FEED_SCHEDULER=1` 并重启开发服务。失败任务15分钟后重试（从失败结束时间计算），成功仍按保存的间隔更新。

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
