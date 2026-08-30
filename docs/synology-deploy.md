# Fire 投资记实 —— 群晖（Docker）部署

面向 **群晖 x86_64（Docker / Container Manager）** 的单机部署。
镜像不含数据：SQLite 数据库与上传素材通过 `volume` 挂载到宿主机目录，镜像可随时替换重建而不丢数据。

## 打包内容
- `Dockerfile` —— 多阶段（deps → build → runner），Node 22-slim；`next start` 运行。
- `docker-compose.yml` —— 本地源码构建入口；端口和持久化目录读取 `.env` 的 `HOST_PORT`、`DATA_DIR`、`UPLOADS_DIR`，未配置时默认 `3000`、`./data`、`./uploads`。
- `.dockerignore` —— 排除 node_modules / .next / data / uploads / .env / .git。

## 部署步骤

### 1. 把项目目录拷到群晖
用 SMB / WebDAV / Git 把整个 `fire-web/` 目录放到群晖指定共享文件夹（例如 `docker/fire`）。
> 只拷源码，**不含** `node_modules`、`.next`、`data`、`public/uploads`（镜像内重建，数据走挂载）。

### 2. 准备生产环境变量
在项目根目录创建 `.env`（复制 `.env.example` 后填写）：
```bash
cd /volume1/docker/fire
cp .env.example .env
# 编辑 .env，至少填写首次建库的管理员（密码 8-128 位且含字母+数字）：
#   INITIAL_ADMIN_USERNAME=admin
#   INITIAL_ADMIN_PASSWORD=你的强密码
```
其余为可选：`STOCKLOG_PROXY`（出站代理）、`DEEPSEEK_API_KEY`（截图导入走云端 OCR，不配则回退本地识别）。

### 3a. 命令行构建并启动（SSH / 计划任务）
```bash
cd /volume1/docker/fire
docker compose up -d --build
```
- 首次构建会拉取 `node:22-slim` 并安装依赖，所需时间取决于 NAS 性能与网络。
- 看日志 `docker compose logs -f fire`，出现监听 3000 即成功。

### 3b. 或用群晖 Container Manager（图形界面）
1. Container Manager → **项目** → **新增**。
2. 名称 `fire`，来源选「上传 docker-compose.yml」或指向项目目录。
3. 构建/启动后，项目状态为「运行中」。

### 4. 访问
- 浏览器打开 `http://群晖IP:3000`。
- 用 `.env` 里 `INITIAL_ADMIN_USERNAME/PASSWORD` 登录（仅首次空库时创建管理员）。
- 如果端口 3000 被占用，在 `.env` 设置 `HOST_PORT=3001`，无需修改 Compose 文件。

## 数据持久化与备份
- **SQLite 数据库 / 附件 / 备份 / 缓存** → `/volume1/docker/fire/data/`（挂载到 `/app/data`）。
- **上传素材**（图标 / 头像 / 截图）→ `/volume1/docker/fire/uploads/`（挂载到 `/app/public/uploads`）。
- 备份：直接打包 `data/` 目录，或用「设置 → 个人信息 → 网站数据导出」生成 JSON 备份文件。
- 升级：拉新代码后重跑 `docker compose up -d --build`，数据不动。

## 说明 / 注意
- **富途 OpenD 桥接**（`scripts/futu_quotes.py`）已由共用 `Dockerfile` 打包 Python 运行时与 `futu-api`，因此本地源码构建和 GHCR 镜像能力一致。未配置或不可达时行情自动回退腾讯 / 雅虎（腾讯源已支持美股港股 A股）。在设置→股票设置→交易·富途里把 OpenD 主机填写为纯 IP/主机名（如 `192.168.x.x`，不要带 `http://`），端口通常为 `11111`，并确保容器能访问该端口。
- **资源**：默认不写死 CPU / 内存限制，请在 Container Manager 中按自己的 NAS 配置设置。
- **健康检查**：每 60s 请求 `/api/settings/public`，失败 5 次标记 unhealthy（不影响运行）。
- 默认 `CMD` 为 `npx next start -H 0.0.0.0 -p 3000`；若后续需要自定义启动（如迁移数据、预建库），可改为挂载自定义 `entrypoint.sh`。
