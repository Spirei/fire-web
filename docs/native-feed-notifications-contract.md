# App 动态通知合约 v1（2026-10-06）

状态：合约已冻结，服务端实现已完成并通过隔离数据库及模拟APNs回归；未部署，不代表生产已具备能力。iOS仅在所选同源`auth/config.data.feed_notifications.version===1`时使用其中固定同版路径，不猜路径，不跨版本兜底。未开启发送配置时仍可同步通知列表与免打扰；`remote_alerts=false`不得宣称退出App已能收到远程推送。

## 来源与正式发布

服务器已存在本人动态生成任务：搜索/生成候选经现有校验后，`appendFeedPosts`将正式新闻写入本人`feed_posts`。仅**新插入正式news动态**生成通知，候选、任务进度、失败、原帖抓取、点赞、讨论、隐藏及历史回填不推送。稳定服务器postId去重，每人每postId一条持久通知。现有历史不补发。

iOS目前本机生成内容不会自动成为服务器发布。新增`POST publications_path`明确同步正式本机动态，需本人feed.write；只有本机已经选定正式发布后才提交，不能把候选全量上传。服务端验证请求、本人分组及正文/来源，事务写入正式feed_posts、通知和提交回执；之后才有远程发送。App断网时显示“尚未同步”，收到提交成功后把本机publicationId映射server postId/groupId，点击通知按服务器身份定位，可用已有GET feed/posts/{postId}读取；不能假设任意本机ID在服务端存在。稳定publicationId小写UUID持久化一次，重复409查询原回执；同组来源指纹重复复用既有postId，不创建另一通知。

本轮本机同步仅新闻文字：`{publicationId,groupId,post:{title,icon,segments:[{text,sourceId}],sources:[{id,title,url,publisher,publishedAt,excerpt}]}}`，不接受owner、hidden、kind、candidate、createdAt、APNs payload或设备目标。groupId为default或本人fg-编号且mode=news。title≤140，segments 1–16条/单条≤700/合计≤2200，sources 1–8条，必须引用来源；来源公网HTTPS无凭据/私有主机，元数据只是本机发布内容，不宣称服务器独立核验新闻真实性。新内容当前服务器时间作为createdAt，来源publishedAt正常ISO日期或null。媒体/人物原帖同步本轮不支持。

## 发现、权限与路径

`feed_notifications`返回以下固定字段，v1将/api/v2替换/api/v1：

```json
{"version":1,"list_path":"/api/v2/feed-notifications","read_path":"/api/v2/feed-notifications/read","preferences_path":"/api/v2/feed-notifications/preferences","devices_path":"/api/v2/feed-notifications/devices","publications_path":"/api/v2/feed-notifications/publications","publication_path":"/api/v2/feed-notifications/publications/{requestId}","read_scope":"feed.read","write_scope":"feed.write","remote_alerts":false,"remote_alerts_reason":"apns_not_configured","publication_sources":["server_news","explicit_local_news_sync"],"automatic_mutation_replay":false,"push_type":"alert","push_content":"generic_no_financial_text"}
```

仅有效App Bearer，Cookie/Web token不能补权限；GET需feed.read，其余需feed.write，登录默认scope不扩张。提交读完请求体/参数后再次核对同grant/user/security stamp，在本人事务内变更。数据与回执按user隔离。账号换密/授权撤销/过期/取消feed.read后设备即无发送资格；即使App退出，grant尚有效且有feed.read时APNs仍可alert。设备注册需同时具备feed.read和feed.write。

成功`{code:0,message:"ok",data}`，失败HTTP+`{code,message}`，no-store/private。不返回token或密钥。重复publicationId=40901；偏好版本冲突=40902；权限不足403；本人数据不存在404。没有配APNs时设备登记503，不能误报就绪。

## 列表与读状态

GET list_path?limit=20&before=123：limit整数1–50，before为上一页返回nextCursor的十进制通知序号；按序号降序稳定分页。data=`{items:[{id,postId,groupId,title,createdAt,readAt}],nextCursor:string|null,unreadCount:number}`。title为服务器正式内容标题；未读数为本人全部未读（不只当前页）。通知表与服务器状态重启保持，不把APNs送达当作已读。

PUT read_path `{ids:["fn-…"]}`，1–100个不重复通知ID，仅本人；全部归属校验后事务已读，重复已读不变。返回`{unreadCount}`。无“全部已读”模糊截止，App分批提交实际已见ID，避免同时新增动态被误读。

GET preferences_path → `{dnd:boolean,revision:number,updatedAt:string|null}`，默认false/revision0。
PUT preferences_path `{dnd:boolean,revision:integer}`，CAS冲突40902。DND全账号跨设备共用，服务器发送前过滤。开启立即取消本账号尚未发送队列，不发alert/sound/badge，**通知内容和未读状态保留**；关闭不补发免打扰期间及取消的旧提醒，仅后续新发布可推送。已提交给APNs/已经到达系统的通知不能撤回，iOS进入前台后读取DND及unreadCount校正界面。

## 设备与环境

PUT devices_path `{installationId:小写UUID,deviceToken:小写十六进制字符串,environment:"sandbox"|"production"}`；token不假设固定64字符，限16–512偶数字符。每账号最多16个有效登记。token与environment/服务器topic绑定；同一安装token变化登记替换，旧未发任务作废，不重新补发。返回`{installationId,environment,registered:true}`，不回显token。另一账号仍有有效登记时409，先从旧账号/授权正常解绑，不让后来的账号抢占。
DELETE devices_path `{installationId}` → `{revoked:true}`；本人安装解绑可重复，不影响别人。退出账号/更换服务器/关闭系统通知时App主动调用；即使调用失败，服务端发送资格仍检查grant。APNs BadDeviceToken/DeviceTokenNotForTopic/Unregistered停止该登记，必须新注册才恢复；旧注册请求的迟到结果不能撤销新版token。

Debug按签名aps-environment选择sandbox；TestFlight/App Store选择production；不能按模拟器/代码编译标记猜。服务器只向配置允许的环境发送，environment不能决定外部任意主机。

## APNs配置与发送

服务器安全配置：`ALCOR_APNS_ENABLED=true`、`ALCOR_APNS_KEY_FILE`（服务器只读挂载的.p8）、`ALCOR_APNS_KEY_ID`、`ALCOR_APNS_TEAM_ID`、`ALCOR_APNS_TOPIC`（真实Bundle ID）、`ALCOR_APNS_ENVIRONMENTS`（sandbox,production或其中之一）。密钥/令牌不进源码、版本库、聊天、前端或日志；需配置出站HTTPS/HTTP2到Apple。默认disabled，配置缺失能力remote_alerts=false；只能服务器人员安全配置，不让普通App提交topic/team/key。

HTTP/2+TLS，ES256 provider JWT，推送type=alert/priority10/expiration0（不让Apple离线长期存储后绕过新DND），稳定apns-id和collapse-id，通用提醒不携带持仓金额、来源正文或账号名。payload：

```json
{"aps":{"alert":{"title":"Alcor","body":"有一条新的动态"},"sound":"default","badge":3,"thread-id":"alcor-feed"},"alcor":{"version":1,"kind":"feed_post","notificationId":"fn-0123456789abcdef01234567","postId":"fp-0123456789abcdef01234567","groupId":"default"}}
```

APNs collapse不保证端到端exactly-once。本轮持久outbox每通知/设备最多一次发送尝试，发送前认领落库，进程崩溃或超时标为未确认，不自动重发以避免重复提醒；通知列表仍完整。HTTP200只是Apple接受，不能宣称用户设备显示。DND/失效授权/隐藏内容发送前重新过滤；已认领但尚未提交的也过滤。没有设备不回补未来登记；DND期间不生成可发送任务。开启DND不会发送badge清零（用户要求立即停止badge）；App前台自行重算。

后台进程定时处理持久队列，与App运行状态无关；多实例原子认领，同实例串行限制。未配置不进行网络发送，现存未发任务标为failed，不复活；禁用后旧队列不复活。通知列表内容仍保留。真实验收需签名真机分别测试两环境、退到后台/结束App、点击定位、重复发布、读状态跨设备、DND即时过滤与授权撤销。模拟网络测试不代表APNs真机完成。

参考：[Apple发送请求](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)、[Apple APNs连接](https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns)。

同一有效连接重复登记完全相同的安装编号、Token、环境和topic视为幂等，不取消已排队通知；Token、授权或归属变化才更换设备版本并取消旧队列。
