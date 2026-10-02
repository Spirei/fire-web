# App 动态 · news 接入合约（修订 1）

App 本轮只实现新闻信息组。服务端保留 Web 已有的 `people` 行为，App 不展示名人组、人物筛选或原帖卡，也不将既有名人组改成新闻组。字段类型以 [feedTypes.ts](../lib/feedTypes.ts) 为准，业务与 Web 共用 [动态服务](../app/api/v1/feed/[[...action]]/route.ts) 和数据库。

## 发现、身份和版本

先读取已选择 origin 的 `/api/v{apiVersion}/auth/config`，保留当前 API 版本和连接。`feed_path`、`feed_scopes` 保持兼容；本修订新增：

```json
{"feed_contract":{"version":1,"groups_path":"/api/v2/feed/groups","subscriptions_test_path":"/api/v2/feed/subscriptions/test"}}
```

v1 的路径使用 `/api/v1`。`feed_contract.version` 是本合约修订号，不是 API 版本。旧部署只有 `feed_path` 不能证明分组管理和订阅测试已放行；缺此声明或接口返回404时，保留原连接并提示该服务器暂不支持当前功能，不改用 Web Cookie 接口或另一个 API 版本。

所有 App 请求带 `Authorization: Bearer fat_…`，采用 `{code,message,data}` 信封；账号响应 `no-store, private`。`feed.read` 读取，`feed.write` 写入且必须同时有 `feed.read`。默认登录仍是 `portfolio.read portfolio.write`，不自动扩权。授权后的 `auth/me.capabilities.feedRead/feedWrite` 反映当前 grant。

用户主动开启动态时，按发现中的 `native_login.permissions_path` 调用固定 v2 原生扩权：

```json
{"client_id":"fire-ios","scope":"feed.read feed.write","currentPassword":"<用户本次输入>"}
```

携带原 App Bearer。无二步时返回 `status:authenticated`；有二步时返回 `purpose:permissions` 的5分钟独立挑战，再携带同一 grant 的有效 Bearer，向 `native_login.two_factor_path` 提交 `{client_id,challenge_token,code}`。成功返回新的 access/refresh、scope、grant_id、user 和 `replaces_grant_id`；先原子保存新凭据并确认本人身份，再用原 grant 的凭据撤销旧连接。失败、取消或保存未确认时保留旧连接，不自动重放写入。详见 [原生登录与扩权](api-spec-v2.md)。

原生扩权响应 `apiVersion:2` 描述该凭证签发端点；它不要求已有 v1 连接切换业务前缀，新 grant 可继续使用原选定版本。也可沿用已有网页 PKCE，明确同意原 scope 加动态范围。普通 token 刷新、页面切换和登录不增加权限。

HTTP403 / `40301` 表示动态权限不足，保留连接；HTTP401 / `40101/40102` 按既有会话策略处理。密码错误 `40103`、因子错误 `40104` 的 HTTP 状态也是403，不当成令牌过期。两版使用相同业务字段和账户边界，v2 不接受 Cookie 或旧 Web Bearer。

## 分组与配置

下表路径相对于选定版本的 `feed_path`。

| 方法 | 后缀 | 请求 / data |
| --- | --- | --- |
| GET | `/groups` | `{groups:FeedGroup[]}` |
| POST | `/groups` | `{name,mode:"news"}` → `FeedGroup`；名称1–40字，每账号最多12组 |
| PUT | `/groups/{groupId}` | `{name,revision}` → `FeedGroup`；保留指示、订阅、开关和间隔，推进同一配置 revision |
| GET | `?group={groupId}&limit=10&cursor=…` | `FeedPayload`，读取当前组的偏好与文章 |
| PUT | `/preferences?group={groupId}` | `{instructions,revision,enabled,intervalMinutes,name?,subscriptions?}` → `FeedPreferences` |
| POST | `/subscriptions/test` | `{name,url}` → `{title,count,url}`；只测试，不保存 |

先 GET `/groups`，仅选择 `mode=="news"`（旧数据缺该字段时按 news）；以服务器返回的组 ID 读取文章。`default` 也可能是 people，不能直接默认读取。没有新闻组时让用户明确创建新闻组；不删除或转换任何既有组。组 ID 为 `default` 或 `fg-` 加24位小写hex，外账号组统一404。当前所选组应作为 App 视图状态保存，每次应用结果校验 origin/grant/apiVersion/group，快速切换不能串组。

指示0–4000字，news 间隔60–1440分钟。使用最新 `preferences.revision`；同一组的名称、指示、订阅与计划共用此 revision，旧值返回40901，先重读再让用户处理草稿。配置保存明确发送读到的 `enabled` 与 `intervalMinutes`，未修改的字段沿用服务器值；历史文章不覆盖。清空指示会关闭新闻自动生成；非空指示保存时若省略 `enabled`，既有兼容行为会启用更新。设置更新使该组旧 revision 的活动任务失效。

订阅最多8个 `{name,url}`，名称1–60字，地址为公开标准端口 HTTPS RSS/Atom，拒绝内网、凭据型地址及重复项。先测试地址；成功结果仍只在草稿中，用户保存 `/preferences` 时提交该组完整 `subscriptions` 列表。不将 `observedPublishers` 当成全部已订阅来源；`recommendations` 只是建议，`group.subscriptions` 才是当前保存值。PUT preferences 只返回偏好，保存后 GET 当前组获取新名称、订阅和 revision。

## 文章、来源和媒体

`FeedPayload` 返回 `posts,nextCursor,preferences,job,group,groups,agent,capabilities`，旧部署的新增可选字段允许缺失。每页默认10条，limit1–50；cursor 为不透明字符串，URL 编码后原样传回，null 表示结束。新闻按生成时间与ID降序，追加更早文章按ID去重；静默同步保留已展开范围，迟到旧请求不覆盖新组。

`FeedPost` 包含 `id,title,icon,segments,sources,media,publishedAt,createdAt,liked,hidden`。时间为UTC ISO，来源发稿日期未知为null；不按生成时间伪造发稿日期。正文使用 `segments[].text`；`sourceId` 对应 `sources[].id`，只有可选 `linkText` 指定的一处原样短语可链接到来源，不把整段染成链接，不解析模型 HTML。旧无 `linkText` 内容保持普通正文，来源仍可从文章菜单查看。呈现规则见 [feedPresentation.ts](../lib/feedPresentation.ts)。

媒体使用真实 `media` 的 `type,url,poster?,alt,playback?`，为空是正常情况，不能生成替代报道图片。`playback:"external"` 在外部打开；其他视频可按真实素材能力播放，离屏及后台暂停。图标只接受 [FEED_ICONS](../lib/feedTypes.ts) 中的键，映射同源 `/uploads/feature/feed/{icon}.webp`；来源与媒体地址不承载 App Bearer，外部打开也不发送 Cookie 或凭据。默认小人资源来自 `capabilities.avatar`，不猜部署素材是否存在。

| 方法 | 后缀 | 请求 / data |
| --- | --- | --- |
| GET | `/posts/{postId}` | 本人 `FeedPost`，包括隐藏文章 |
| PUT | `/posts/{postId}` | `{liked?:boolean,hidden?:boolean}` → `FeedPost`；false撤销，至少一个字段 |
| GET | `/posts/{postId}/discussion` | `{messages:FeedMessage[]}`，最近40条正序 |
| POST | `/posts/{postId}/discussion` | `{text}`，1–2000字 → `{messages}`；失败不保存半个回合 |

隐藏后主列表不再返回该文章，原ID仍可本人读取或恢复；跨账号文章与讨论404。写入超时结果不确定时先 GET 核对，不自动补发。模型不可用时保留文章，讨论如实呈现错误。

## 更新任务与 Agent 面板

| 方法 | 后缀 | 请求 / data |
| --- | --- | --- |
| POST | `/refresh?group={groupId}` | `{}` → `FeedJob`；用户明确更新，后台执行，已有活动任务复用 |
| GET | `/jobs/{jobId}` | 本人 `FeedJob` |
| GET | `/jobs?group={groupId}&cursor=…` | `{jobs,nextCursor}`，每页30条，本组任务历史 |
| GET | `/profile` | `FeedAgentProfile`：`name,image,revision,updatedAt` |
| PUT | `/profile` | `{name,revision}` 或 `{resetAvatar:true,revision}` → 新资料 |
| POST | `/profile/avatar` | multipart `file` + `revision`，真实PNG/JPG/WebP/GIF，最大2 MiB → 新资料 |

job 状态 `queued/searching/writing/done/error`，`id,createdAt,updatedAt,added,error,revision,groupId` 都来自服务端。已知活动任务在前台约2.5秒读取一次；完成后重读对应组文章。正常信息流前台每分钟只读一次，返回前台合并过期读取；离页、离屏与后台取消请求和轮询，不因读取、页面进入或空列表自动POST付费生成。生产调度独立于 App，开发默认关闭；任务失败保留历史。

Agent 资料按当前账号跨组保存，其 revision 与组配置独立。name1–40字，`image:null` 表示默认形象；头像上传或恢复默认保留名称和组指示。自定义图像时 `capabilities.avatar.video=null`，默认视频仅在服务端有实际素材时返回。静音循环、减少动态时静态，实际播放后淡入，离屏及后台暂停；不把上传进度当成已保存形象。冲突409或超时先重读资料，不自动重放改名/上传。

Web 的五个 Agent 页签复用现有数据：更新记录使用本组 jobs；关注来源使用 `group.subscriptions`；运行状态使用当前 job 与 capabilities；更新计划使用 preferences 与最近任务；名称与形象使用 profile。没有精确“下一次执行”字段，不虚构确定执行时刻，也不创建新的管理员或模型配置接口。任务历史在两端统一以北京时间显示日期和时间。

## 发布与验证

本合约不自动发布服务端。部署前使用现有可用端点，新增分组与订阅操作按实际能力声明判定。发布后重新核对发现和 App Bearer 请求；公开端点401只能证明认证边界存在，不能证明真实账号全部业务已验收。

[app-feed.cjs](../tests/app-feed.cjs) 在临时SQLite及模拟网络覆盖两版发现、scope不足403保留连接、Cookie不补权、news分组与CAS、关闭计划保留、文章分页/媒体/喜欢/隐藏/讨论归属、订阅测试不保存以及异步撤销。原生扩权、因子与令牌轮换沿用 [app-native-login.cjs](../tests/app-native-login.cjs)，不读取正式App令牌，不改真实偏好或持仓。
