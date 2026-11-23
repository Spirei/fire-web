# Alcor 裸机 Linux VPS 部署指南（无 Docker / 单一 PostgreSQL 库）

本文档面向直接在 Linux VPS（Ubuntu 24.04 / Debian 12+）运行 Alcor 的部署方式：不依赖 Docker 或 Watchtower，全站只维护**唯一一个 PostgreSQL 实例与数据库**，由 `systemd` 托管服务、`Caddy`（或 `Nginx`）负责 HTTPS 反代。

## 1. 基础组件

- Node.js 20 LTS（含 `npm`）
- Python 3.12 与 `uv`（`platform/.venv` 隔离运行内置 FastAPI + Worker）
- PostgreSQL 17（唯一权威库，启用 `postgresql-client-17` 与同步落盘）
- Redis 7（行情/读取预算缓存，按最小 ACL 配置）
- Caddy（自动申请与续期 TLS 证书）

## 2. 目录与权限约定

建议创建专用系统用户 `alcor`（无 root 权限运行）：

```bash
sudo useradd --system --home /opt/alcor --create-home --shell /usr/sbin/nologin alcor
sudo install -d -o alcor -g alcor -m 0700 /var/lib/alcor/backups /var/lib/alcor/secrets /var/lib/alcor/files /var/lib/alcor/assets /run/alcor
```

## 3. 拉取源码与安装依赖

```bash
sudo -u alcor git clone https://github.com/<your-org>/fire-web.git /opt/alcor/app
cd /opt/alcor/app
sudo -u alcor npm ci
sudo -u alcor uv sync --frozen --no-dev --project platform --extra futu
sudo -u alcor npm run build
```

## 4. 环境配置（`/etc/alcor/alcor.env`，权限 `0600`）

```dotenv
NODE_ENV=production
PORT=3000
FIRE_ENVIRONMENT=production
FIRE_PUBLIC_ORIGIN=https://your-domain.example
FIRE_DATABASE_URL=postgresql://alcor_app:<strong-password>@127.0.0.1:5432/alcor
FIRE_INSTANCE_ID=<your-existing-instance-uuid>
FIRE_REDIS_URL=redis://alcor_app:<strong-password>@127.0.0.1:6379/0
FIRE_BACKUP_DIR=/var/lib/alcor/backups
FIRE_BACKUP_SECRET_DIR=/var/lib/alcor/secrets/backup
FIRE_CONNECTION_SECRET_DIR=/var/lib/alcor/secrets/connections
FIRE_FILE_ROOT=/var/lib/alcor/files
FIRE_ASSET_ROOT=/var/lib/alcor/assets
FIRE_PG_TOOLS_DIR=/usr/lib/postgresql/17/bin
FIRE_NATIVE_LEDGER_ENABLED=1
FIRE_WORKER=on
```

从群晖迁移到 VPS 时：
1. 在原站「数据管理 → 账本核准」先点击一次**「固化期初到单库」**，把历史迁移期初永久写入 PG 表 `owner_ledger_checkpoints`，摆脱磁盘 `database-migrations` 原件目录依赖；
2. 停止写入后，对原唯一 PG 库执行 `pg_dump -Fc` 并恢复到 VPS 唯一 PG 库；
3. 同步复制 `backup.key`、连接密钥目录与素材/上传目录到新 VPS（权限 `0700` / `0600`），保留同一个 `FIRE_INSTANCE_ID`；
4. 运行配置与 schema 校验：
   ```bash
   set -a && source /etc/alcor/alcor.env && set +a
   npm run platform:config
   npm run platform:check
   ```

## 5. `systemd` 服务单元（`/etc/systemd/system/alcor.service`）

```ini
[Unit]
Description=Alcor Investment Platform
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=alcor
Group=alcor
WorkingDirectory=/opt/alcor/app
EnvironmentFile=/etc/alcor/alcor.env
RuntimeDirectory=alcor
RuntimeDirectoryMode=0700
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/alcor /run/alcor /opt/alcor/app/.next/cache /opt/alcor/app/public/uploads

[Install]
WantedBy=multi-user.target
```

启用服务：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now alcor
curl -fsS http://127.0.0.1:3000/health/ready
```

## 6. Caddy 反向代理（`/etc/caddy/Caddyfile`）

```caddyfile
your-domain.example {
    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
}
```

## 7. 日常升级与维护（零 Docker 命令）

```bash
cd /opt/alcor/app
sudo -u alcor git pull --ff-only origin main
sudo -u alcor npm ci
sudo -u alcor uv sync --frozen --no-dev --project platform --extra futu
sudo -u alcor npm run build

# 如有新增 SQL 迁移，停服后显式执行：
sudo systemctl stop alcor
sudo -u alcor bash -c 'set -a && source /etc/alcor/alcor.env && set +a && npm run platform:migrate -- --database alcor'
sudo systemctl start alcor
```

## 8. 唯一 PG 库冷备策略

- 仅维护这唯一一份在线 PostgreSQL 库，不在宿主机并存旧库/新库；
- 每日定时用 `pg_dump -Fc` 生成加密离线冷备并同步至异地对象存储或 NAS，避免将备份库当作第二套线上库读取。
