# 个人券商账户 v1（2026-10-17，字段冻结；已实现待集成，尚未部署）

本文件供并行接线，服务端源码已实现并验证，不表示线上服务器已支持。cd7c922 登录修复的发布不含本功能。只维护本人记账账户，不连接真实券商、不索取凭据，不承诺券商数量或导入能力。

## 能力发现与权限

同源所选 `/api/v1/auth/config` 或 `/api/v2/auth/config` 的 data 新增可选 `broker_accounts`：

```json
{
  "version": 1,
  "presets_path": "/api/v2/broker-accounts/presets",
  "accounts_path": "/api/v2/broker-accounts",
  "account_path": "/api/v2/broker-accounts/{accountId}",
  "icon_path": "/api/v2/broker-accounts/{accountId}/icon",
  "operation_path": "/api/v2/broker-accounts/operations/{requestId}",
  "read_scope": "portfolio.read",
  "write_scope": "portfolio.write",
  "request_id_field": "requestId",
  "revision_field": "revision",
  "automatic_mutation_replay": false,
  "icon_upload": {
    "content_types": [
      "image/png",
      "image/jpeg",
      "image/webp"
    ],
    "max_bytes": 2097152,
    "max_dimension": 4096,
    "max_pixels": 16777216
  },
  "currency_selection": {
    "version": 1,
    "field": "currencies",
    "default_field": "currency",
    "supported": [
      "USD",
      "EUR",
      "HKD",
      "CNY",
      "JPY",
      "KRW",
      "SGD",
      "GBP",
      "AUD",
      "CAD",
      "TWD",
      "MOP",
      "INR",
      "BRL"
    ],
    "usage_field": "currencyUsage",
    "removal_requires_complete": true
  },
  "holding_source": {
    "version": 1,
    "field": "holdingSource",
    "manual_path": "/api/v2/broker-accounts/{accountId}/holding-source",
    "takeover_field": "takeOverOfficial",
    "default_source": "manual",
    "offline_fallback": false
  },
  "record_binding_id_field": "brokerAccountId",
  "binding_path": "/api/v2/broker-accounts/{accountId}/bindings",
  "unbinding_path": "/api/v2/broker-accounts/{accountId}/unbindings",
  "statements": {
    "connectors": [
      {
        "id": "ibkr-flex",
        "providerId": "ibkr",
        "label": "IBKR · Flex官方账单",
        "helpUrl": "https://www.ibkrguides.com/advisorportal/ug/flex3.htm",
        "accept": ".xml,application/xml,text/xml",
        "fileLabel": "Activity Flex XML",
        "maxBytes": 8388608,
        "externalAccountLabel": "官方账户编号",
        "fields": [
          {
            "key": "externalAccount",
            "label": "官方账户编号",
            "secret": false
          },
          {
            "key": "queryId",
            "label": "Flex Query ID",
            "secret": false
          },
          {
            "key": "token",
            "label": "Flex Token",
            "secret": true
          }
        ]
      }
    ],
    "connection_path": "/api/v2/broker-accounts/{accountId}/connection",
    "preview_path": "/api/v2/broker-accounts/{accountId}/statements/preview",
    "fetch_path": "/api/v2/broker-accounts/{accountId}/statements/fetch",
    "apply_path": "/api/v2/broker-accounts/{accountId}/statements/apply",
    "max_bytes": 8388608,
    "preview_required": true,
    "automatic_apply": false
  },
  "record_binding": "owner_record_group_exact_account_name",
  "delete_referenced_account": "reject"
}
```

v1全部路径使用`/api/v1`。只有version=1及固定同源路径/字段验证通过，且当前真实grant包含读写scope时才开放写操作。没有能力/离线只显示离线预设，不可显示保存成功。Bearer-only；不借Cookie补权限，App管理员身份不继承Web管理权限。Web若接入使用本人会话和同源校验，权限不扩展到全局共享目录。

## 公共机构目录与个人账户分离

GET presets_path -> `{code:0,message:"ok",data:{items:[Preset]}}`。
Preset：`{id,name,aliases:string[],defaultCurrency,icon:string|null}`。icon优先为同源Web素材库真实已有图标，再回退随镜像提供的12个官方App图标 `/broker-presets/{id}.jpg`（来源及SHA见broker-icon-sources.json），实际文件不存在时返回null，不编造URL。iOS按id使用自带图标离线兜底。
稳定ID共12项：longbridge, ibkr, futu, tiger, trading212, moomoo, robinhood, huatai, schwab, usmart, eastmoney, ths。盈立=usmart、盈透=ibkr、嘉信=schwab；同花顺/东方财富仅记账机构标识。机构目录只读，预设图标可由Web管理员素材库维护，个人上传不能污染目录。
旧GET/POST/DELETE `/brokers` 保持共享目录和管理员权限。为避免字符串绑定歧义，共享目录新名称/别名也不能与已存在的个人账户重名（409）；共享改名/删除钩子不修改个人账户已绑定的本人记录。不得把个人账户写到site_settings.groups，也不能放开旧/brokers写权限。

## 账户读取

GET accounts_path -> `{code:0,message:"ok",data:{accountId:"当前用户ID",items:[Account],collectionRevision:0}}`。
GET account_path -> `{code:0,message:"ok",data:Account}`。
Account固定字段：

```json
{"id":"ba-opaque","name":"我的盈透","providerId":"ibkr","currency":"USD","revision":1,"icon":null,"iconSource":"preset","recordGroup":"我的盈透","recordCount":0,"createdAt":"ISO8601 UTC","updatedAt":"ISO8601 UTC"}
```

providerId为上述ID或null（自定义）；currency为服务端FUND_CURRENCIES支持的三位ISO币种。name去首尾空白，1–60字符，禁止控制字符。本人账户名大小写不敏感唯一，并与当前共享券商名称/别名区分（例如“我的盈透”）；不同用户隔离。recordGroup严格等于保留大小写的name。icon为真实可读取的同源路径或null；iconSource只为custom/preset/none，预设图标缺失时preset仍允许iOS按providerId离线兜底。自定义上传优先于preset。

个人列表绑定账号/授权/所选API版本和缓存代次；切换或撤权时清除，不能将旧异步响应写入新账户。collectionRevision为本人账户集合递增版本；具体修改仍核对account.revision。

## 与持仓、交易及资产的关联

现有records的group、broker展示/选择继续沿用字符串。编辑器把旧/brokers共享选项与本人账户选项分别读取；选中个人账户时写入该Account.recordGroup到现有records安全提交接口，沿records的requestId及recordRevision/CAS，不另造一份持仓或交易。
服务端本人records.group精确等于本人Account.name时归属于该账户；账户列表recordCount为本人精确匹配数量。创建账户时若该名字已经存在本人records.group，返回40902，不能默默认领旧记录；用户可选不冲突名称，再通过现有记录编辑明确归属。不批量认领/迁移旧全局共享数据，不修改他人记录。
账户改名必须同时提供当前records集合collectionRevision（字段名recordCollectionRevision）；同一事务内核对版本、仅更新本人精确匹配旧recordGroup的记录，沿既有records更新机制递增版本。改名后的Account.recordGroup同步更新；原record ID、持仓数量/价格/成本、交易ID、资金、证券声明和真实订单不变。无记录绑定时改名仍须核对recordCollectionRevision，避免并发新增绑定漏更新。目标名字若已被本人其他账户或本人其他group记录使用则冲突。
资产配置本人brokers选项合并个人账户（id=Account.id）；其证券节点使用稳定 `broker:{Account.id}:{证券结算币种}`，改名不改变节点ID或已有核对记录，assign沿已有CAS仅选本人账户。旧GET/brokers仍只返回共享目录；客户端不得把个人账户保存回共享目录。
account-assets继续读取同一records和真实账本。不会新建持仓、重复计资产或新建资金。客户端按本人Account.recordGroup关联rawRecord.group即可，无须假设新增brokerAccountId字段。旧/brokers名称和全局分类仍存在；个人列表不是替代全局目录的写接口。
删除账户时若存在本人引用记录（包括零持仓/自选）返回40902。先通过正常records编辑明确迁移或取消引用，再重新确认删除；不自动清空券商或删除订单/资金。图标更新不改记录group或版本。

## 创建/编辑/删除与回执

POST accounts_path JSON：`{requestId:"小写UUID",name,providerId:null|预设ID,currency}`。严格拒绝未知字段。成功创建revision=1。本人最多100个账户；超限40902。
PUT account_path JSON：`{requestId,revision,name,currency,recordCollectionRevision}`。providerId创建后不可修改；更换机构须另建账户。currency只是账户默认记账货币，不转换或改写任何已有记录/资金；已有持仓币种仍按证券市场/真实来源核算。
DELETE account_path JSON：`{requestId,revision}`。
每次新的用户确认使用新requestId。成功 HTTP200（创建201）信封data为Operation：
`{requestId,kind:"create"|"update"|"delete"|"upload_icon"|"reset_icon",accountId,state:"completed"|"failed",code:0,message:"ok",completedAt:"ISO8601 UTC",data:Account|null}`。
写入与成功回执同一事务；删除data=null。创建在分配账户ID之前遇到名称/限额业务冲突时，failed回执固定为kind=create、accountId=""、data=null；仅此组合允许空ID，表示没有创建账户。创建成功以及所有其他kind必须有对应真实ba-账户ID；失败创建不能视为本地保存成功。有效已授权命令的业务冲突以failed回执保存；输入/权限/来源不合法未执行，不创建业务回执。版本冲突HTTP409/code40902；重复requestId HTTP409/code40901，查询原回执，不重放命令。
GET operation_path返回当前用户本人Operation，跨用户/不存在40401。超时、离线、进后台不自动重放，先查询；404也不是自动重提授权。需要用户重新确认时生成新UUID并重读版本。
所有私有JSON及图标响应no-store/private。成功不得依赖客户端本地虚构账户；必须使用真实返回的id/revision/icon。

## 图标上传/重置/读取

POST icon_path：multipart字段严格为requestId（UUID）、revision（十进制字符串）、file（单个图片）。每个预设和自定义账户均允许上传/再次更新，CAS采用当前账户revision，成功递增并返回upload_icon回执中的最新Account。私有图标缓存键必须包含授权/账号/Account.id及revision，成功上传或重置后清除旧缓存。
支持PNG/JPEG/WebP；按真实文件头及解码结果校验，不仅依赖扩展名或Content-Type；单文件<=2MiB、宽高各<=4096、总像素<=16777216，拒绝动画、多帧、SVG、外部资源及畸形数据。服务端规范化为不含元数据的单帧PNG，缩至最大512px；限制multipart总字节防止内存滥用。
GET icon_path读取本人custom图标，未上传40401；不允许匿名或其他用户，Bearer要求portfolio.read，站点本人会话同源规则沿已有认证。不使用公开/uploads路径、不透露磁盘绝对路径。Account.icon在custom时为同源icon_path；APIClient以当前授权请求图片，不能让匿名AsyncImage直读。图标读取鉴权通过后返回image/png及no-store/private、nosniff。
DELETE icon_path JSON `{requestId,revision}`，返回reset_icon回执；清除本人覆盖，恢复当前真实预设icon或null（自定义账户为none/null）。绝不删除共享预设图标。规范化图片以私有SQLite BLOB保存，随账户、revision及回执同一事务替换；失败回滚保留旧图，不产生公开附件或孤立文件。成功替换/重置即回收旧BLOB，不冒充保存成功。

## 错误/范围

401失效授权、403缺scope/来源、404本人资源不存在、40901重复请求、40902版本/名称/引用冲突、40001参数/图片不合法、413文件/请求超限、50001存储失败。一般错误信封`{code,message}`；已保存failed回执可经operation查询。无用户枚举或跨账号资源查询。
部署前必须临时库/私有文件回归：双版本、只读/读写授权、Cookie不能提升、跨用户隔离、改名记录版本与回滚、旧共享目录不变、CAS/重复/超时原回执、图标真实性/尺寸/字节/动画限制、上传失败旧图保留、恢复默认与引用删除拒绝。

## 多币种选择能力（2026-10-18）

发现 `currency_selection.version=1` 后，App才能向原create/update发送可选`currencies`数组；缺能力不猜传未知字段。
服务端支持币种以发现supported为准，至少一种、无重复，`currency`仍是默认币种且必须属于集合；这是账户配置，不是余额、兑换或分拆账户。
create示例：`{requestId,name,providerId:null,currency:"USD",currencies:["USD","HKD"]}`。
update示例：`{requestId,revision,recordCollectionRevision,name,currency:"HKD",currencies:["USD","HKD"]}`。
原UUID/账户与完整持仓集合CAS/成功失败回执保持。集合以服务端标准顺序返回。
旧create省略集合时默认为[currency]；旧update省略时保留全部已有币种并合入新默认，不因旧App编辑删减。
旧账户无集合时以原默认兼容；服务端读取完整在用币种并安全合入支持的币种，不能因旧配置遗漏实际持仓而把它隐藏。

账户GET、list及新成功回执额外返回：

```json
{"currency":"USD","currencies":["USD","HKD"],"currencyUsage":{"complete":true,"usedCurrencies":["HKD","USD"],"recordCollectionRevision":42,"issues":[]}}
```

客户端据此获得完整使用集合，**不依赖分页持仓/第一屏/当前筛选**。读数据和删减检查均为服务端本人账户全量查询：所有关联记录（含零数量）、历史订单报价/结算币种、已导入官方现金报告及归档流水币种。
港股通同时保护HKD报价与CNY结算。其他账户同股/同币种不误归入本人当前账户。
已有使用币种不可移除；删减时若complete=false，同样40902并保留原配置、原失败回执可查。
issues当前包含unknown_currency、invalid_position、invalid_statement_cash、invalid_statement_event、unscoped_legacy_funds；App宜显示无法完整核对并禁删减，不自造完整集合。
旧全局fund_transactions没有个人券商ID；非零且无法按官方订单ID归属的资金不按名称猜归属，而令完整性false。添加币种、集合内更改默认不受此缺失限制。
真实新持仓/官方报告仍按其证券及结算币种记账；不受显示默认币种重解释。后续出现新的使用币种时读取安全合入支持集合；该集合不作为拒收真实账单的币种白名单。

## 历史持仓ID兼容（2026-10-18）

bindings.recordIds必须原样使用records接口返回的稳定ID，不限定r-16位格式。支持历史和备份恢复ID（恢复器生成r-24位）；每项为1至128字符的非空字符串，不含控制字符，禁止重复。服务端按原文精确匹配本人完整持仓，不trim、不重写ID；不存在/跨用户404，账户/集合CAS和官方来源40903保持。

## 已关联持仓批量移出（2026-10-18）

auth/config的broker_accounts新增可选`unbinding_path`，值为`/api/v{1|2}/broker-accounts/{accountId}/unbindings`，POST、portfolio.write；未发现能力不得猜测DELETE或用完整RecordInput伪装解绑。
请求严格为`{requestId,revision,recordCollectionRevision,recordIds}`，不接受allowReassign。recordIds原样使用本人records返回的稳定ID（1–128字符、非空、无控制字符、不重复；兼容16/24hex/历史ID），最多2000条。
服务端在同一事务校验账户revision、完整记录集合版本；全部选择必须仍属于本人当前账户，否则整批404不修改。官方来源拒绝手动移出40903；版本冲突40902。
仅清空选中记录brokerAccountId和兼容group；证券身份、价格数量成本、备注、自选分组、历史订单及现金保持。每条记录版本/集合版本和账户revision正常递增。
回执沿原operations路径，kind:unbind_records，成功data最新BrokerAccount（recordCount更新）；业务失败state:failed/data:null，原UUID可查；重复requestId40901不重放。超时未知保留requestId查原，不自动换ID重试。前置格式/认证错误不保存回执。
原生“已关联”页签只列当前账户本人记录，可选移出。旧服务不提供能力时保留列表且禁用批量移出，不改真实归属作测试。

### 新建与编辑持仓直接关联（2026-10-18）

沿 records 原有 POST/PUT 与 requestId/revision/operations 合约传 brokerAccountId，一次事务保存记录和账户归属，无需再调用 bindings。只能指定本人仍存在的手动账户；最新账户名称由服务端回填 group。编辑省略 ID 保留原关联，显式空字符串才移出。官方账户返回40903，外人或删除账户返回404。

本人同账户下，按 market、importIdentity 规范代码、有效账户市场防重；HK直持与HK/CN港股通隔离，空accountMarket与行情市场相同均视为直持。新增或编辑身份／账户形成重复返回40902，不合并数量成本；不同账户同股独立。检查与写入位于同一个IMMEDIATE事务，多连接竞争最多一条成功。旧重复不迁移删除，身份不变的编辑仍允许。失败requestId原回执可查，重复UUID不重放。

买入入口应优先使用显式发现的 account_trading.buy_target，协议与完整字段见 [原生交易合约](app-account-trading.md)。records直接关联仍作为补录入口，禁止先创建零仓再发交易请求。
