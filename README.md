# Fire · Web（fire-web）

Next.js 15 + React 19 + TypeScript + Tailwind + SQLite（better-sqlite3）全栈 Web 端，统一使用端口 3000。

## 生产环境首次启动

空数据库在生产环境不会再创建公开的默认管理员。未配置 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 时，首次访问登录或后台会进入 `/setup` 创建首位管理员；也可参考 `.env.example` 用环境变量预置管理员。已有数据库不受此初始化逻辑影响。

## 常用命令

```bash
npm run dev              # 开发（固定监听 0.0.0.0:3000）
./scripts/smoke-test.sh  # 冒烟测试（82 项）
npm run clean:dsstore    # 清理 .DS_Store
```

## 关键位置

- 业务组件：`components/views/`
- 数据层：`lib/`（store / auth / quotes / assets / celebsData / earnings …）
- API 路由：`app/api/`（旧接口）+ `app/api/v1/`（规范接口，移动端统一对接）
- API 规范文档：`docs/api-spec.md`（页面 `/api-docs`）
- 数据 / 素材 / 备份：`data/`、`public/uploads/`
- 项目规范：`AGENTS.md`；版本记录：`lib/versions.ts` + `VERSIONS.md`
