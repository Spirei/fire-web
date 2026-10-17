# 个人账户持仓与 IBKR 官方账单

面向 iOS 原生账户及账单流程，服务端仅提供 App 接口，不新增 Web 页面。

## 持仓归属

`StockRecord.brokerAccountId` 为本人个人账户稳定 ID；无该字段或空串为未绑定。
旧客户端继续按 `group` 写入：与本人个人账户精确同名时建立稳定关联；共享目录不变。
升级只固化原先已由精确名称定义的关联，不把其他分组猜测为某家券商。
显式 ID 必须属于本人，服务端以账户名称回填兼容字段；改名不改变账户 ID。
同证券可分属不同账户，资产节点按稳定 ID 隔离。原不区分账户的订单导入遇到同证券多账户时拒绝，不再选择最后一条。

POST `/api/v{1|2}/broker-accounts/{accountId}/bindings`：
`{requestId, revision, recordCollectionRevision, recordIds:["r-…"], allowReassign?:true}`。
账户和持仓集合均须匹配预览版本；默认只接收本人未绑定/已绑定该账户的记录；自由调整其他账户的记账归属时，App明确展示原/目标账户并确认后传 `allowReassign:true`。这不向券商发起真实转仓。
同账户重复证券拒绝。只修改归属，持仓数量、成本、订单及资金不变。
回执与原个人账户接口共用 `/operations/{requestId}`。

## IBKR 接入（v1/v2 同构，portfolio.read / portfolio.write）

| 方法 | 账户相对路径 | 用途 |
| --- | --- | --- |
| GET | `/connection` | 是否配置、最近账单日期与分币种现金核对数；不返回 Token |
| PUT | `/connection` | `{requestId,revision,connectorId:"ibkr-flex",token,queryId,externalAccount}` 加密保存 Flex 配置 |
| DELETE | `/connection` | `{requestId,revision}` 删除读取凭据，保留账单及持仓 |
| POST | `/statements/preview` | multipart `file`＋`externalAccount`＋`connectorId`，UTF-8 Activity Flex XML，最大8MiB |
| POST | `/statements/fetch` | 固定官方HTTPS读取；202＋`pending:true,retryAfterSeconds:15` 表示等待，再次POST轮询 |
| POST | `/statements/apply` | `{requestId,revision,previewId,acknowledgeUnassigned?}` 确认预览 |

所有接口仅接受App Bearer，不用Cookie补授权。账户名称、预设机构与官方渠道解耦；自定义账户也能选择官方渠道。
发现协议 `broker_accounts.statements.connectors` 返回当前已实现适配器及配置字段、文件类型、官方帮助地址；App按元数据构建原生表单。首个渠道为 `ibkr-flex`，其他渠道在验证完成后注册，不按账户名称或providerId限制持仓联动。
预览结果包含 `previewId,accountRevision,collectionRevision,rows,missing,cash,eventCount,warnings`。
`rows.before` 为现值，`missing` 为该账户账单未列出、确认后数量清零的记录。
无对应账户持仓但存在同证券未绑定记录时，先显式绑定并重新预览，或明确勾选分开记账（`acknowledgeUnassigned:true`）。
预览保存24小时，持仓/账户变化需重新预览；不接收客户端修改后的财务行。
成功配置/断开/导入写持久回执，不自动重放，重复 UUID 返回409，可查询原回执。
校验失败/冲突整体回滚，不写成功回执；超时未知结果应先查询回执及账户快照。

## 财务处理边界

- 仅接受完整 Open Positions SUMMARY；仅STK、美港A股与匹配币种，需conid、上市交易所、报告日期、数量、价格、每股成本。不能识别的资产、空头、批次/Model拆分、缺字段均拒绝整份导入。
- 账单结束日期须等于持仓报告日期；拒绝早于或同日不同内容的已导入快照，拒绝覆盖已有更晚订单或待成交订单。
- 账户内持仓按期末快照更新，不把历史成交再次加减到快照。缺失持仓数量归零而非删除，保留历史订单。
- Trade EXECUTION、CashTransaction、CorporateAction、Transfer 按官方流水 ID 归档并去重；归档不写成本重放订单，不自动改变资金余额。缺流水ID会在预览明确提示；同ID内容更正拒绝自动覆盖。
- 分币种期末现金保存在账单核对中，不直接增加旧资金账本。当前未自动导入订单历史到交易页，也未承诺全部税务成本/复杂衍生品兼容。
- 同账户报表内容归一化SHA去重；相同文件/相同内容重复上传返回alreadyImported。
- Token使用既有AES-GCM密钥管理；不保存券商登录密码，固定官方主机与API路径，禁重定向/任意响应URL，网络错误不泄露Token查询串。
- 接口读取由用户发起，不自动定时改写真实账户；用户仍需自行在IBKR生成Token/Query并填写配置。

## 官方依据

- https://www.ibkrguides.com/advisorportal/ug/flex3.htm
- https://www.ibkrguides.com/reportingreference/reportguide/open%20positionsfq.htm
- https://www.ibkrguides.com/reportingreference/reportguide/tradesfq.htm

## 后续渠道

先完成IBKR实账样本兼容验证，再依次做Trading 212报告/账户API、长桥、富途/moomoo、老虎与嘉信。
Robinhood走官方CSV；华泰按实际账户API权限；东方财富/盈立待确认官方格式与权限；同花顺按实际开户券商处理。
官方存在API不等于这些适配器已完成，不对外宣称已支持未实现渠道。

## iOS冻结响应样例（2026-10-17）

### 发现

GET `/api/v{1|2}/auth/config` 的 `data.broker_accounts` 为发现入口。
`statements.connectors` 就是渠道目录，没有额外的connector目录请求；它是已实现适配器的能力清单，不是支持所有券商的承诺。
同级 `record_binding_id_field`、`binding_path`、`operation_path` 及 `statements.*_path` 均为所选API版本的固定同源路径。
首个适配器元数据：

```json
{"id":"ibkr-flex","providerId":"ibkr","label":"IBKR · Flex官方账单","helpUrl":"https://www.ibkrguides.com/advisorportal/ug/flex3.htm","accept":".xml,application/xml,text/xml","fileLabel":"Activity Flex XML","maxBytes":8388608,"externalAccountLabel":"官方账户编号","fields":[{"key":"externalAccount","label":"官方账户编号","secret":false},{"key":"queryId","label":"Flex Query ID","secret":false},{"key":"token","label":"Flex Token","secret":true}]}
```

渠道与账户 `providerId` 不做硬绑定。任意本人账户（包括 `providerId:null`）都能选择已实现渠道，持仓绑定不需要配置渠道。
未知的connectorId返回422；旧调用未传connectorId时仅为兼容首批IBKR客户端默认 `ibkr-flex`，新客户端须明确传发现的ID。

### 连接状态

```json
{"code":0,"message":"ok","data":{"configured":true,"connectorId":"ibkr-flex","latest":{"toDate":"20261016","cash":[{"currency":"USD","endingCash":1200}],"importedAt":"2026-10-17T12:00:00.000Z"}}}
```

未配置时 `configured:false,connectorId:null`；无已导入账单时 `latest:null`。
不返回Token、Query ID或完整官方账户编号；修改配置时重新输入。PUT/DELETE成功后账户revision递增，须重新GET账户，不从旧revision猜测下一次提交。

### 读取等待

POST fetch 无请求体。HTTP 202：

```json
{"code":0,"message":"ok","data":{"pending":true,"retryAfterSeconds":15}}
```

App等待至少15秒，可再次POST；不重复启动并发读取。服务端保存官方reference，不向客户端暴露带Token的官方URL。
若请求连接超时，只重试读取，不自动执行apply。fetch无财务操作回执，因为它不写持仓/现金。

### 上传/读取完成的预览

POST preview 返回以下data；fetch HTTP200时在同一data额外带 `pending:false`：

```json
{"code":0,"message":"ok","data":{"alreadyImported":false,"previewId":"bsp-0123456789abcdef0123456789abcdef","digest":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","accountRevision":3,"collectionRevision":12,"toDate":"20261016","fromDate":"20261001","cash":[{"currency":"USD","endingCash":1200}],"eventCount":1,"warnings":["持仓按期末快照核对；历史流水单独归档，不再次累加持仓或扣减现金"],"rows":[{"key":"US:AAPL","conid":"265598","code":"AAPL","name":"Apple","market":"US","currency":"USD","qty":5,"price":200,"cost":150,"recordId":"r-0123456789abcdef","before":{"qty":3,"cost":140,"price":190},"action":"update","unassignedMatches":[]}],"missing":[],"requiresUnassignedAcknowledgement":false}}
```

`rows.action` 为create/update；create时recordId/before为null。`before` 数值可为空串以兼容旧记录。
`missing` 项为 `{recordId,code,market,before:number,after:0}`，必须在确认界面明确展示，不当作删除记录。
相同账单已导入时只返回 `{alreadyImported:true,digest}`（fetch另有pending:false），没有previewId，不显示确认导入按钮。

### 确认导入及通用回执

请求：

```json
{"requestId":"12345678-1234-4234-8234-123456789abc","revision":3,"previewId":"bsp-0123456789abcdef0123456789abcdef","acknowledgeUnassigned":false}
```

成功响应（同样存入GET原operation路径）：

```json
{"code":0,"message":"ok","data":{"requestId":"12345678-1234-4234-8234-123456789abc","kind":"import_statement","accountId":"ba-0123456789abcdef01234567","state":"completed","code":0,"message":"ok","completedAt":"2026-10-17T12:00:00.000Z","data":{"digest":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","updated":1,"created":0,"closed":0,"eventCount":1,"collectionRevision":13}}}
```

新kind的 `operation.data` 是联合类型，不强行解码为BrokerAccount：

| kind | data |
| --- | --- |
| bind_records | BrokerAccount，与原update相同；仍有completed/failed回执，失败data:null |
| configure_statement | `{configured:true}` |
| disconnect_statement | `{configured:false}` |
| import_statement | `{digest,updated,created,closed,eventCount,collectionRevision}` |

后三类的成功状态是completed；校验/CAS/业务冲突失败整笔回滚，**不保存失败回执**。
原create/update/delete/upload_icon/reset_icon回执保持原合同；新绑定也复用它，不改变旧kind的data形状。
重复requestId返回40901，并要求查询原operation；不能自动换UUID重放财务确认。
若apply/配置响应超时，先持久保留原requestId并GET operation：存在则按其kind/data确认；404仅表示当前未找到已提交回执，仍需读取账户及持仓快照确认，保持未知结果提示，不自动重放。收到明确4xx失败才可重新预览并让用户再次确认。
完成后刷新账户、持仓及资产快照；账户revision会递增，记录集合revision以回执或重新读取为准。

### 自由联动确认

```json
{"requestId":"12345678-1234-4234-8234-123456789abd","revision":4,"recordCollectionRevision":13,"recordIds":["r-0123456789abcdef"],"allowReassign":true}
```

只有用户明确确认调整原/目标账户记账归属后才传allowReassign:true。遗漏默认拒绝跨已绑定账户调整；同账户重复证券仍拒绝。
