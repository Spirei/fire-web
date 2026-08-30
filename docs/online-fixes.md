# 线上版测试修复与优化留档

> 背景：在把 fire-web 部署到群晖 Docker 并实测线上版时，暴露出一批**致命错误**与**可优化项**。以下修复与优化**全部已落到 `fire-web/` 本地源码**（线上镜像即由该源码构建），因此本地版与线上版**同源一致、无版本漂移**。

---

## 一、致命错误（线上暴露 → 已修复）

| # | 问题现象 | 根因 | 修复位置 |
|---|----------|------|----------|
| 1 | amd64 / 群晖 `docker build` 失败 | `prod-deps` 阶段 `npm ci --omit=dev` 重装 `better-sqlite3` 需 node-gyp 源码编译，但该阶段缺 `python3/make/g++` | `Dockerfile`：给 `prod-deps` 补编译工具链 |
| 2 | 容器内 `next build` 失败 | `app/manifest.ts` 构建期被静态预渲染并读取站点设置（触发建库 seed），空库 + `NODE_ENV=production` 下因缺 `INITIAL_ADMIN_*` 报错 | `app/manifest.ts`：加 `export const dynamic = "force-dynamic"` |
| 3 | 登录成功却无限跳回登录页 | session cookie 固定 `secure: NODE_ENV==="production"`，局域网 `http://IP:port` 明文访问时浏览器不保存/不发送该 cookie → 会话丢失 → 反复跳回 /login | `lib/auth.ts`：新增 `sessionCookieSecure(request)`（按请求是否 HTTPS 判断）；`app/api/auth/login/route.ts`、`app/api/auth/register/route.ts` 复用 |
| 4 | 生产空库首次启动报错、首个管理员建不出来 | `seed()` 强制要求合法 `INITIAL_ADMIN_USERNAME/PASSWORD`，未填/用户名超 20 位/密码弱即抛错 | `lib/db.ts`：`seed()` 放宽（仅两者合法才建管理员，否则跳过）；配合 `lib/auth.ts` `createUser()`：首个非测试注册账号自动成为 `admin` |
| 5 | 上传成功但访问 404（头像 / 素材图标 / 背景 / logo 全覆盖） | `next start`（生产）只服务构建/启动时已存在的 `public/` 文件，运行时写入 `public/uploads/...` 的新文件不被静态服务 | 新增 `app/uploads/[...path]/route.ts`：动态从磁盘读取并返回上传文件（`Cache-Control: max-age=0, must-revalidate`） |
| 6 | FIRE 导航图标显示「旧圆点」 | `public/uploads/asset/icon/fire.svg` 文件缺失（只有 `fire-dark.svg`/`fire-gray.svg`），素材库 FIRE 指向它 → 404 → 回退默认「◎」 | 新增火焰 `fire.svg`；同步更新 `lib/navIcons.tsx` 的 `fire` 图标 |
| 7 | 名人持仓「巴菲特」头像空圈 | `lib/celebs.ts` 引用 `/uploads/celebs/buffett.jpg`，但仓库无该文件（只有 `buffett-custom-*.png`） | 用仓库已有巴菲特图生成 `public/uploads/celebs/buffett.png`，并更新引用 |

### 排查结论（供留档）
- 上传 404 非单一图标问题：**生产 `next start` 不服务运行期新增的 `public` 文件**，本地 `next dev` 正常。已用动态路由兜底解决。
- 股票图标空：素材库股票图标原为「同步大市值股票」**按需填充**；改为用本地高精度素材库（`data/fire.db` 结构化数据）生成 `lib/assets-default-stock.json` 预置播种，开箱即用。
- 市场图标缺失：`MarketIcon` 在无本地市场图标时回退 **本地打包国旗**（`asset/flag/<iso>.svg`，UK→gb），不再请求远程 CDN。

---

## 二、重要优化（线上验证后改进）

| # | 优化项 | 说明 |
|---|--------|------|
| 8 | 群晖 Docker 资源限制修复 | `cpus: 2.0` 触发「NanoCPUs can not be set，kernel does not support CPU CFS」报错 → 去掉 `cpus`；`mem_limit` 按 20G 放宽到 `6g`（`docker-compose.yml`） |
| 9 | 资源全走本地 | `MarketIcon` 删除 flagcdn / 长桥 LB 远程兜底，改为「本地素材库 → 本地国旗 → 本地矢量地球」；`CurrencyFlag` 用本地旗帜文件 |
| 10 | 基础素材打包进镜像 | `.dockerignore` 纳入 `asset` / `celebs` / `currency` / `ico` / `login` / `logo` / `background`，排除用户数据 `avatar` / `reports` / 分组图标；`scripts/entrypoint.sh` 首次启动把默认资源幂等复制到 `./uploads` 挂载 |
| 11 | 素材库开箱即用 | 播种：icon 26 / market 5 / crypto 39 / metal 4 / flag 251 / **stock 1182**；`MarketIcon` 对 SG/UK/DE/FR/AU 等用国旗兜底 |
| 12 | 头像上传限制与报错 | 上限 `1MB → 5MB`（`lib/upload.ts` + 前端提示「≤ 5MB」）；写盘/目录错误包装成 `UploadError`，前端显示具体原因而非泛化「上传失败」 |
| 13 | 导入 / 导出 / 备份链路确认 | `/api/v1/data/export`、`/api/v1/data/import`、`/api/backup` 均正常（200） |
| 14 | 站点域名自动检测内外网 | `/api/settings/public` 在未手动配置（或仍为占位 `localhost:3000`）时按请求 `Host` 自动推导；手动填写则尊重 |
| 15 | 镜像瘦身 | `.dockerignore` 排除 `public/mockups`、`fire-planner-preview.html`、`settings-mockup-standard.html`、`public/fire`、`dist` 等非运行产物 |
| 16 | 图标加载兜底 `SafeAssetImage` | 图片加载失败回退内置矢量默认图标，避免浏览器「? / 破图」占位；接入侧栏、货币、设置菜单预览 |
| 17 | 挂载卷遮挡默认资源兜底 | `/uploads/[...path]` 在宿主机挂载目录缺文件时回读镜像内 `resource-default`，全球经济热图国旗、默认图标与名人头像不再因旧卷缺文件而 404 |
| 18 | 名人头像发布映射同步 | 内置名人默认头像与 `default-avatars.json` 一起进入默认资源，本地源码重建和 GHCR 新容器均使用同一套定制头像 |
| 19 | 富途运行时两端统一 | 共用 `Dockerfile` 的 runner 内置 Python venv 与 `futu-api`；本地 `docker compose up --build` 和 GHCR 都不会再出现 `spawn python3 ENOENT` |
| 20 | 部署一致性自动审计 | 新增 `npm run audit:deploy` 并接入 GitHub Actions，自动检查两份 Compose 的端口/卷/环境一致性，以及默认资源和富途运行时是否仍被打包 |

---

## 三、本地版同步状态与验证

所有改动都在 `fire-web/` 本地源码内；部署相关文件（`Dockerfile` / `docker-compose.yml` / `scripts/entrypoint.sh` / `.dockerignore`）也在仓库，本地重跑 `docker compose up -d --build` 即得与线上一致版本。

### 关键修复已在源码（抽查）
- `Dockerfile`：`prod-deps` 含 `python3 make g++` ✅
- `app/manifest.ts`：`force-dynamic` ✅
- `lib/auth.ts` / `login` / `register`：`sessionCookieSecure` ✅ ；`createUser` 首注册=admin ✅
- `lib/db.ts`：`seed()` 放宽 ✅
- `app/uploads/[...path]/route.ts`：动态上传服务 ✅
- `public/uploads/asset/icon/fire.svg`、`public/uploads/celebs/buffett.png` ✅
- `components/MarketIcon.tsx`：本地国旗兜底 ✅
- `lib/assets-default-stock.json`：股票预置种子（约 171KB）✅
- `scripts/entrypoint.sh`：`resource-default` 复制 ✅
- `Dockerfile`：runner 含 Python venv + `futu-api`，本地 / GHCR 共用 ✅
- `app/uploads/[...path]/route.ts`：挂载目录缺文件时回读 `resource-default` ✅
- `docker-compose.yml` / `docker-compose.ghcr.yml`：端口与持久化目录变量一致 ✅
- `npm run audit:deploy`：CI 自动阻止两端配置漂移 ✅

### 建议本地回归
```bash
cd fire-web
npx tsc --noEmit            # 类型检查（已 PASS）
./scripts/smoke-test.sh     # 82 项冒烟（需起本地实例，会备份并还原设置）
```

---

## 四、受改动文件清单（`fire-web/`）

**业务 / 路由**
- `app/api/auth/login/route.ts`、`app/api/auth/register/route.ts`（cookie secure）
- `app/api/settings/public/route.ts`（domain 自动检测）
- `app/api/assets/route.ts`（播种触发）
- `app/uploads/[...path]/route.ts`（动态上传服务）
- `app/manifest.ts`（PWA manifest 动态化）
- `app/layout.tsx`（favicon 兜底）

**库**
- `lib/auth.ts`、`lib/db.ts`（认证 / seed）
- `lib/upload.ts`（头像大小、错误包装）
- `lib/assets.ts`（素材播种 icon/market/crypto/metal/flag/stock）
- `lib/navIcons.tsx`（FIRE 火焰图标）
- `lib/celebs.ts`（巴菲特头像）
- `lib/assets-default-stock.json`（股票预置种子）

**组件**
- `components/RecordsApp.tsx`、`components/CurrencyFlag.tsx`、`components/views/SettingsView.tsx`（SafeAssetImage 接入 / 提示）
- `components/MarketIcon.tsx`（本地国旗兜底）
- `components/SafeAssetImage.tsx`（新增）

**部署 / 资源**
- `Dockerfile`、`docker-compose.yml`、`.dockerignore`
- `scripts/entrypoint.sh`、`scripts/build-amd64-image.sh`
- `public/uploads/asset/icon/fire.svg`、`public/uploads/celebs/buffett.png`
- `AGENTS.md`（资源本地化 / 上传路由约定）、`lib/versions.ts`、`VERSIONS.md`（版本记录）
