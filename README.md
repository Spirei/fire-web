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
