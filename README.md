# Alcor · Web（fire-web）

Next.js 15 + React 19 + TypeScript + Tailwind + SQLite（better-sqlite3）全栈 Web 端，统一使用端口 3000。

## 生产环境首次启动

空数据库在生产环境不会再创建公开的默认管理员。未配置 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 时，首次访问登录或后台会进入 `/setup` 创建首位管理员；也可参考 `.env.example` 用环境变量预置管理员。已有数据库不受此初始化逻辑影响。

邮箱自助找回密码需要 SMTP。管理员可在“设置 → 数据与系统 → 邮件服务”中配置并发送测试邮件，也可通过 `.env.example` 中的 `SMTP_*` 环境变量提供默认值；网页保存的配置优先。

## 常用命令

```bash
npm run dev              # 开发（固定监听 0.0.0.0:3000）
npm run smoke:account    # 首次注册独立本地测试账号，后续执行只验证并复用
npm run smoke            # 使用独立账号进行只读页面、认证和 API 巡检
npm run test:review      # 临时数据库中的业务写入与管理员权限回归
npm run clean:dsstore    # 清理 .DS_Store
```

本地测试账号默认名为 `fire_smoke`，注册时为普通权限、不占 UID；随机密码保存在忽略 Git 的 `data/smoke-account.json`（权限 0600），不使用默认 demo。管理员可通过用户管理调整权限，巡检按账号当前权限验证。`SMOKE_USERNAME` 可在首次注册时指定名称，`SMOKE_ACCOUNT_FILE` 可指定凭据文件；文件绑定目标地址，不会把本地凭据发往不同服务器。外部实例只读取它自己的凭据配置，不自动注册账号。`BASE` 默认 `http://localhost:3000`，回环地址 `127.0.0.1` 也可复用同一配置。

## 关键位置

- 业务组件：`components/views/`
- 数据层：`lib/`（store / auth / quotes / assets / celebsData / earnings …）
- API 路由：`app/api/`（旧接口）+ `app/api/v1/`（规范接口，移动端统一对接）
- API 规范文档：`docs/api-spec.md`（页面 `/api-docs`）
- 数据 / 素材 / 备份：`data/`、`public/uploads/`
- 项目规范：`AGENTS.md`；版本记录：`lib/versions.ts` + `VERSIONS.md`

## 源码打包备份

源码备份默认每天北京时间 **14:00** 和 **23:59** 各执行一次，保留全部成功生成的历史压缩包，不按数量自动删除。本地调度通过 Codex 的两个定时任务调用 `npm run backup:source`；调度时本机、Codex 和目标备份卷需可用。

备份目录通过不进 Git 的 `data/source-backup-config.json` 配置，例如：

```json
{
  "destination": "/path/to/mounted/backup/source",
  "requiredMount": "/path/to/mounted/volume"
}
```

目标目录须预先存在。每份备份目录包含 `source.tar.gz` 压缩包和 `manifest.json` 校验清单。每次完成结果显示压缩包大小（自动使用 KB / MB / GB 等单位，并列出精确字节数），清单中的 `archiveSize` 同时记录实际压缩包字节数。可用 `python3 scripts/backup-project.py --verify /path/to/backup` 重新校验并查看大小；旧备份没有大小字段时仍可正常校验。

压缩包包含当前 Git 工作区中的已跟踪文件、未提交修改及未被忽略的新源码，也包含随源码分发的默认素材与数据。排除依赖、构建产物、真实环境配置及被 Git 忽略的运行数据；网站数据库和用户上传继续使用独立的数据备份。

先在本机打包，再复制到目标卷；整包和逐文件 SHA-256 校验通过后发布新备份。挂载不可用、写入或校验失败、源码打包期间改变时保留旧备份；并发运行使用本机文件锁，失败只清理本次尚未完成的临时文件，不删除历史备份。恢复时将压缩包解到新目录，再按项目说明安装依赖与配置环境。

`npm run test:source-backup` 使用临时项目检查恢复、全部历史保留、大小记录与报告、旧清单兼容、损坏及失败保护，不访问真实业务数据。
