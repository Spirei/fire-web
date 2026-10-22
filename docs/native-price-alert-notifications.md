# 股价提醒通知接入 · 2026-10-21

原生 0.2.377，服务端 v0.1.64。用户确认补齐企业微信个人绑定及股价提醒；保留 App 内、邮件及 Telegram。

## 发布及配置

本次只修改源代码、临时数据库验证与正常 App 模拟器构建；未部署服务端、未发送真实通知、未推送手机。按项目既定流程手动发布 Web 服务。长期运行 Node 实例通过 instrumentation 每5秒启动一轮监控，SQLite租约隔离多实例；不适用于仅按请求唤醒的无常驻服务平台。

- `ALCOR_PRICE_ALERTS_ENABLED=false` 可停止监控与修改。默认启用，旧本机草稿不自动上传。
- App 内：真实事件持久化到本人收件箱，前台铃铛轮询；不包含 APNs 锁屏推送。
- 邮件：复用现有 SMTP/TLS 和邮件额度，仅向本人已验证邮箱发送；沿原账户邮箱验证流程配置，不接受任意收件人。
- Telegram：优先沿 Web 通知与配置保存的 Bot Token/用户名，环境变量仅作原兼容来源，使用独立机器人；worker通过官方getUpdates轮询，不应与其他消费者或现有webhook混用。密钥只在服务器环境中配置。App获取5分钟一次性深链，在机器人私聊发送start后回App确认显示的账号，再开启通道。聊天ID加密保存，绑定令牌只存hash，拒绝群组、过期与重复使用。

## 合同与行为

`auth/config` 的 `price_alerts` 显式发现 v1协议及v1/v2规范路径。GET `price-alerts` 返回本人accountId、集合版本、规则、通道状态、最近200事件和未读数。POST `price-alerts/operations/{UUID}` 执行规则upsert/delete/state、channel、read、test或Telegram确认/解除；GET同路径只查询原回执，重复POST返回409，不自动重放。POST `price-alerts/telegram-link` 获取一次性私聊深链。所有路径沿原App授权，读取portfolio.read、修改portfolio.write；写前重新核对当前授权。

规则使用Decimal字符串最多6位小数、本人规则版本CAS、真实市场币种，港股HKD；美股默认全时段。监控仅消费行情池新鲜非缓存报价，核对来源、原行情时间≤90秒、真实交易时段、激活时间和授权存活，不更改订单、资产、费用或现金。仅一次触发后完成；每天一次按市场交易日去重。真实记录保存PRE/REGULAR/AFTER/OVERNIGHT及行情时间。

事件、一次触发完成状态及发送队列在同一事务保存。SMTP/Telegram返回接受回执显示accepted；不冒充已读或最终送达。发送前再检查授权、规则版本与通道；超时、崩溃后不重发，unknown保留供核对。手动测试仅在用户点击时入队，文字明确为测试。App内事件为delivered。已启用绿色圆点仅来自服务器监控状态，本机草稿仍待启用。

原生检查accountId、源/授权/私有缓存代次、版本与快照顺序；迟到响应不覆盖新状态。规则保存在服务端，旧本机草稿只有用户显式保存才上传；服务端未公布能力时仍为本机草稿及待接入，不伪造绑定或发送。

## 验证

`node tests/price-alerts.cjs` 使用临时SQLite、独立授权及拦截SMTP/Telegram：本人隔离、读写权限、CAS、原UUID回执、6位Decimal、新鲜报价、时段、每天去重、撤销/到期、验证邮箱、Telegram一次性私聊与显式确认、接受回执及未知结果不重发。不使用真实账户，不发送真实消息。正常App构建及模拟器UI另行记录。

## 线上缺口核对（2026-10-21）

线上健康检查为v0.1.62 / 97dd2032b569b827dc2167a23bf2812a7d5cfd78，v1 auth/config没有price_alerts，v2/price-alerts返回404。用户API授权正常不等于旧镜像已提供提醒；v0.1.63须按项目流程发布镜像并更新群晖，之后核对两个版本发现合同及未授权401（不再404），再由本人App显式启用原草稿。不自动上传/启用存量规则，不发送验证消息。

## 股价提醒邮件模板

设置的邮件模板列表包含price_alert（股价提醒），支持编辑、恢复默认及无发送的手机/桌面预览。变量包括stockName、stockCode、market、currentPrice、targetPrice、currency、direction、session、quoteTime、triggerTime，以及原公共变量。实际触发邮件读取保存模板、嵌入同一品牌图片，只发送本人验证邮箱；主动测试使用明确的邮件服务测试模板，不伪造成价格触发。旧五个模板的自定义保留，新的股价模板默认中性灰阶。

按用户最终纠正，股价邮件沿用其他账户邮件的统一品牌图、排版与圆角价格区，默认正文缩为股票代码/市场及触发条件，价格区显示触发价和较小提醒价，底部仅实际时段/触发时间。价格模板编辑隐藏不用的称呼/结束语，旧账户邮件保持。

## 企业微信个人绑定（0.2.377 / v0.1.64）

Web 保存并开启企业 ID、AgentId、应用 Secret。App 只读取 social-channels 的脱敏配置状态；企业应用可见范围应包含目标成员。配置状态不代表本人已经绑定。

`auth/config.price_alerts.wechat = {version:1,binding:"verification-code"}` 显式声明能力。支持的客户端对 price-alerts 快照及操作/原回执请求发送 `X-Alcor-Price-Alerts: wechat-v1`，返回 app/email/telegram/wechat 四渠道；未协商的旧客户端仍返回原三渠道。基础 version 保持1。

沿已有 POST operations/{UUID}，均需当前 channelRevision：

- `wechat_start`：`recipient` 为单个成员 UserID（1–64 位 ASCII 字母数字、下划线、@、点、横线），拒绝 @all、分隔符和群组。只排队向该成员发送 6 位验证码，不启用通知。每本人及每目标每小时最多5次，限流持久保存。
- 快照返回 `challengeId`、`verificationState`（queued/sending/accepted/unknown/failed/expired/cancelled/locked）、`verificationExpiresAt` 及 `pendingConfirmation`。验证码有效5分钟，不返回原码；数据库仅加密短暂保存待发原码、以数据密钥 HMAC 保存校验摘要，投递后清原码。
- `wechat_confirm`：`challengeId`、`verificationCode` 和显式 `enabled:true`。本人/挑战/应用身份/CAS校验后原子绑定并开启；错误验证码次数仍提交，最多6次，不因事务回滚重置。未知发送若用户已实际收到仍可验证，不自动重发。
- `wechat_disconnect`：仅解除本人，删除加密接收目标与待确认资料，并关闭该通道。
- `channel` 开关与 `test` 沿已有协议，只有本人完成验证码确认才可用。Telegram 的 `telegram_confirm` 同样支持显式 `enabled:true`。

正式触发仅向本人已验证的单个成员发企业应用文本消息；不使用群机器人 Webhook、管理员列表或全员广播。接收账号加密保存，企业应用改变后重新绑定。provider 明确拒绝为 failed，带 msgid 的成功为 accepted；HTTP异常、超时或崩溃遗留为 unknown，不自动重发。服务器 access_token 仅内存缓存、按应用/密钥/代理隔离，响应限定64KiB且不跟随重定向。

本轮验证仅使用临时数据库和拦截传输；实际企业微信收件、线上部署及手机安装需另行完成，不将模拟传输回执冒充真实收件。
