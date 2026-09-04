# syntax=docker/dockerfile:1
# =====================================================================
# Fire 投资记实 —— 纯净生产版镜像（Node 22 + SQLite + sharp）
# 目标：运行镜像只含生产依赖 + .next 产物 + 静态资源，无源码/dev 依赖/构建工具。
# 数据与上传走 volume（宿主机 ./data、./uploads），镜像本身不含数据。
# 富途 OpenD 桥接（scripts/futu_quotes.py）随生产镜像提供 Python + futu-api，
# 未配置或不可达时行情自动回退腾讯/雅虎（腾讯源已支持美股/港股/A股）。
# =====================================================================

# ---------- 1. 依赖：全量安装（供构建用），含原生模块编译工具 ----------
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN (test -f package-lock.json && npm ci && echo "LOCK_OK") || npm install

# ---------- 2. 生产依赖：只保留 dependencies（剔除 devDependencies）----------
FROM node:22-slim AS prod-deps
WORKDIR /app
# better-sqlite3 等原生模块需 node-gyp 从源码编译（预编译二进制拉不到时回退），
# 需 python3/make/g++；该工具链在本阶段安装，仅其 node_modules 被 COPY 到 runner，
# 不会进入最终运行镜像，仍是纯净生产版。
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
# 兜底：若 npm ci --omit=dev 因 lockfile 失败则用 prune 清理
RUN (test -d node_modules && npm prune --omit=dev >/dev/null 2>&1 || true)

# ---------- 3. 构建：生成 .next 生产产物 ----------
FROM node:22-slim AS build
WORKDIR /app
ARG FIRE_BUILD_SHA=unknown
ENV FIRE_BUILD_SHA=${FIRE_BUILD_SHA}
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- 4. 运行：纯净精简镜像 ----------
FROM node:22-slim AS runner
WORKDIR /app
ARG FIRE_BUILD_SHA=unknown
ENV NODE_ENV=production
ENV FIRE_BUILD_SHA=${FIRE_BUILD_SHA}
ENV NEXT_TELEMETRY_DISABLED=1

# 只带运行必需：生产 node_modules + .next 产物 + 静态 + 配置 + 仓库脚本(futu 桥接脚本文件)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/public/uploads /app/resource-default
# 交易广场缓存作为首次启动种子；运行期仍写入挂载的 /app/data，已有数据不会被覆盖。
RUN mkdir -p /app/trading-square-default
COPY --from=build /app/data/duan-posts.json /app/trading-square-default/duan-posts.json
COPY --from=build /app/data/trump-posts.json /app/trading-square-default/trump-posts.json
COPY --from=build /app/data/trump-translations.json /app/trading-square-default/trump-translations.json
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/lib ./lib
COPY package.json ./
COPY next.config.mjs ./
COPY scripts/entrypoint.sh /app/entrypoint.sh
# OpenD 桥接依赖必须随 GHCR 生产镜像提供；否则线上容器虽能连通 11111，
# Node spawn("python3") 仍会因运行时缺少 Python 直接报 ENOENT。
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-venv && \
    python3 -m venv /opt/futu-venv && \
    /opt/futu-venv/bin/pip install --no-cache-dir -r /app/scripts/requirements-futu.txt && \
    rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/futu-venv/bin:${PATH}"
RUN chmod +x /app/entrypoint.sh

# 运行期数据与上传占位（由 compose volume 挂载覆盖）
RUN mkdir -p /app/data /app/public/uploads && chmod -R 777 /app/data /app/public/uploads

EXPOSE 3000
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

ENTRYPOINT ["sh", "/app/entrypoint.sh"]
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
