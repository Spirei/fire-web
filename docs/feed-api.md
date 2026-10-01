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
| GET | `/api/v1/feed?limit=20&cursor=…` | `FeedPayload`；limit 1–50，创建时间/id 降序游标 |
| PUT | `/api/v1/feed/preferences` | `{instructions,revision,enabled?,intervalMinutes?}` → `FeedPreferences` |
| POST | `/api/v1/feed/refresh` | `{}` → 持久化 `FeedJob`；后台执行 |
| GET | `/api/v1/feed/jobs/{id}` | 本人 `FeedJob` |
| GET | `/api/v1/feed/posts/{id}` | 本人 `FeedPost`，包括隐藏状态 |
| PUT | `/api/v1/feed/posts/{id}` | `{liked?:boolean,hidden?:boolean}` → `FeedPost`；false 撤销 |
| GET | `/api/v1/feed/posts/{id}/discussion` | `{messages:[…]}`，最近 40 条正序 |
| POST | `/api/v1/feed/posts/{id}/discussion` | `{text}`，1–2000 字 → `{messages:[…]}`；失败不保存半个回合 |

唯一字段类型是 `lib/feedTypes.ts`。时间统一 UTC ISO 8601，`publishedAt` 来自来源发稿时间，未知 null；`createdAt` 是生成时间。帖子 id `fp-` + 24 位 hex，任务 `fj-`，消息 `fm-`。

`FeedPayload` 含 `posts,nextCursor,preferences,job,capabilities`。帖子含 `title,icon,segments,sources,media,publishedAt,createdAt,liked,hidden`；`segments[].sourceId` 指向本帖来源，客户端显示链接，不解析模型 HTML。图标为 `/uploads/feature/feed/{icon}.webp`。媒体只预留经校验资源；没有实际素材返回 `[]`，不能用模型生成 URL 伪造图片。

指示最多 4000 字，`revision` 必填并做 CAS，旧版本 40901。修改只影响未来动态，历史不替换；同时取消旧版本任务。清空指示关闭定期生成。间隔默认 360 分钟，可设 60–1440；仅生产容器自动执行，开发不自动调用付费模型。

任务状态 `queued/searching/writing/done/error`，同账号唯一活动任务，多 worker 数据库原子认领，全站最多 8 个活动任务。中断超过 5 分钟恢复 error，可重试。Web 仅当前动态页/前台轮询 2.5 秒，App 后台或离开也应停止轮询。失败保留历史，不插入模拟新闻。

`capabilities.generate` 表示模型可用；`search` 为 `brave/news-rss`。小人原始眨眼、转头循环视频已本地化：`avatar.video=/uploads/feature/feed/alcor-idle.mp4`（H.264、480×480、24fps、约5秒、358KB，无音轨），`avatar.image` 为本地静态回退。只在上传卷或镜像默认资源存在时返回视频地址，否则 null。App 使用静音循环、前后台暂停、减少动态时静态、加载成功 500ms 淡入，不用 CSS 晃动图片代替表情。

## 搜索与安全

提炼、讨论复用「设置 → 模型服务」。全网搜索需服务端 `BRAVE_SEARCH_API_KEY`；留空使用 Google News RSS 新闻检索，新闻范围不能宣称为完整全网。Brave 参数依据[官方文档](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)。摘要不等于文章全文，模型只准总结来源可支持的事实。

最多 3 条检索词、36 个来源、8 条动态；搜索固定主机、禁跳转、12 秒超时，模型单次 35 秒，正文/响应体/分页有上限。来源只允许公网 HTTPS；拒绝明显邮件、地址、密钥型检索词。模型输出的 URL/日期/媒体不入库。兴趣指示会传给管理员配置的模型，请不要填写秘密。

每账号生成 6 次/小时、讨论 20 次/小时，SQLite 共享全站预算。异步读取正文及讨论上游返回后重新鉴权，断开连接不能继续写入。错误不泄露内部诊断；用量审计不保存正文或密钥。`node tests/feed.cjs` 在临时数据库与模拟网络验证，不修改真实账号。
