# Fire

Fire 是网页、App 接入和后台管理的统一平台。网页使用 Next.js，内置业务后端使用 FastAPI 和原生 PostgreSQL；Redis 保存可重建缓存，独立 Worker 执行任务。当前实现使用 PostgreSQL；未来可根据收益、迁移成本和数据一致性评估其他数据库，不保留已经退出的 SQLite 兼容链。

## 获取与配置

```sh
npm ci
```

网页和内置后端在同一份 Fire 源码中维护。使用 Python 3.12，在 `platform` 目录执行 `uv sync --frozen --extra futu` 安装后端依赖。将私有配置保存在环境中，参考 `.env.example`；不要提交真实配置。

本地 SVG 品牌图转换需要 Cairo。macOS 可安装 Homebrew 的 Cairo，启动器会发现标准安装目录；其他位置可通过 `DYLD_FALLBACK_LIBRARY_PATH` 指定。生产镜像已包含 Cairo 运行库。


## 本地 PM2 启动

使用 `npm run dev:pm2`。从任意目录启动可执行 `node /实际项目路径/fire-web/scripts/pm2-dev.mjs`。
`ecosystem.config.cjs` 固定项目目录；启动脚本最多等待 120 秒确认网页可访问后保存配置。
端口使用 `PORT` 或 `npm run dev:pm2 -- --port 3001` 指定。同名进程来自其他目录或端口已被其他服务占用时停止操作，可用 `FIRE_PM2_NAME` 指定独立进程名称。失败时查看对应 PM2 名称的日志。
PM2 的 online 仅表示进程存在，应以网页检查为准。开机或登录自动启动属于本机系统配置，须单独安装。
启动时显示源码提交，提示未提交源码及相对已获取主分支的落后情况；不会自动覆盖本地工作。远端比较以最近一次 `git fetch origin` 为准。

已有数据库必须先核实实例身份、迁移版本、完整备份及切换方案。启动命令不会创建或迁移数据库，不读取旧数据库文件，也不会自动回退存储。数据库初始化与实际数据导入需另行执行已核实的操作。

```sh
npm run dev -- --port 3001
npm run build
npm start -- --port 3001
```

端口可配置。`FIRE_PUBLIC_ORIGIN` 是浏览器实际访问地址，须包含非标准端口。`FIRE_PYTHON` 指向安装后端依赖的 Python。Fire 自动创建私有 Unix socket 并管理内置后端的进程，不对外暴露额外后端端口。`FIRE_WORKER=on` 启用独立 Worker；隔离验收时保持关闭，按需单独验证任务执行。

## 管理

系统总览统一管理 PostgreSQL、Redis 和 Worker；后台任务可查询持久回执、详情及取消状态。接口迁移页读取 `contracts/fire-api-surface.json` 并逐项核对实际注册的方法与路径，接入状态不代表页面已验收。旧数据及备份不会由源码更新自动迁移或删除。

```sh
npm run test:review
npm run test:backend -- tests/test_fire_web.py
npm run audit:public
npx tsc --noEmit
```

业务回归在后端组件的隔离 PostgreSQL 实例中运行。`ALCOR_TEST_ROOT` 和 `TMPDIR` 可配置测试目录。源码备份使用 `npm run backup:source`，其目标保存在忽略 Git 的本机配置中。
