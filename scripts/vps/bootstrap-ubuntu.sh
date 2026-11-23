#!/usr/bin/env bash
# Bare-metal Ubuntu 24.04 / Debian 12+ bootstrap for Alcor (no Docker, single PG 17 + Redis 7 minimal ACL).
set -euo pipefail

DOMAIN=""
INSTANCE_ID=""
DB_NAME="alcorfire"
DB_USER="alcorfire"
REDIS_USER="alcor_app"
APP_DIR="/opt/alcor/app"
ENV_FILE="/etc/alcor/alcor.env"

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/vps/bootstrap-ubuntu.sh \
    --domain <your-domain> \
    --instance-id <existing-alcor-instance-uuid> \
    [--db-name alcorfire] \
    [--db-user alcorfire] \
    [--redis-user alcor_app] \
    [--app-dir /opt/alcor/app]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --instance-id) INSTANCE_ID="${2:-}"; shift 2 ;;
    --db-name) DB_NAME="${2:-}"; shift 2 ;;
    --db-user) DB_USER="${2:-}"; shift 2 ;;
    --redis-user) REDIS_USER="${2:-}"; shift 2 ;;
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi
if [[ -z "$DOMAIN" || -z "$INSTANCE_ID" ]]; then
  echo "--domain and --instance-id are required." >&2
  usage
  exit 1
fi
if ! [[ "$INSTANCE_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "Invalid --instance-id UUID format." >&2
  exit 1
fi
if ! [[ "$DB_NAME" =~ ^[a-z][a-z0-9_]{1,62}$ && "$DB_USER" =~ ^[a-z][a-z0-9_]{1,62}$ && "$REDIS_USER" =~ ^[a-z][a-z0-9_]{1,62}$ ]]; then
  echo "Invalid identifier for --db-name, --db-user, or --redis-user." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release openssl git rsync \
  libstdc++6 libcairo2 redis-server

# 1. Install PostgreSQL 17 from official PGDG repository with verified GPG fingerprint.
install -d -m 0755 /usr/share/keyrings
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/postgresql.asc
gpg --show-keys --with-colons /usr/share/keyrings/postgresql.asc \
  | grep -q '^fpr:::::::::B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8:'
CODENAME="$(lsb_release -cs)"
echo "deb [signed-by=/usr/share/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update
apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17

# 2. Install Node.js 20 LTS and Caddy if missing.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y --no-install-recommends nodejs
fi
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y --no-install-recommends caddy
fi

# 3. Install uv for isolated Python 3.12 runtime management.
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
fi

# 4. System user & strict 0700 private runtime directories.
if ! id -u alcor >/dev/null 2>&1; then
  useradd --system --home /opt/alcor --create-home --shell /usr/sbin/nologin alcor
fi
install -d -o alcor -g alcor -m 0700 \
  /var/lib/alcor \
  /var/lib/alcor/backups \
  /var/lib/alcor/secrets \
  /var/lib/alcor/secrets/backup \
  /var/lib/alcor/secrets/connections \
  /var/lib/alcor/files \
  /var/lib/alcor/assets \
  /etc/alcor

# 5. Generate strong credentials once (or reuse if ENV_FILE already exists).
if [[ -f "$ENV_FILE" ]]; then
  echo "Existing $ENV_FILE found; preserving existing credentials."
else
  DB_PASS="$(openssl rand -hex 24)"
  REDIS_PASS="$(openssl rand -hex 24)"

  # Configure single authoritative PostgreSQL 17 database & role.
  systemctl enable --now postgresql
  su - postgres -c "psql -v ON_ERROR_STOP=1" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
  END IF;
END \$\$;
SQL
  if ! su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"" | grep -q 1; then
    su - postgres -c "createdb -O ${DB_USER} ${DB_NAME}"
  fi
  su - postgres -c "psql -d ${DB_NAME} -v ON_ERROR_STOP=1 -c \"ALTER DATABASE ${DB_NAME} SET synchronous_commit = on;\""

  # Configure Redis 7 with persistent minimal ACL scoped strictly to read-budget keys.
  ACL_FILE="/etc/redis/users.acl"
  REDIS_PREFIX="alcor:${INSTANCE_ID}:read-budget:*"
  cat > "$ACL_FILE" <<ACL
user default off
user ${REDIS_USER} on >${REDIS_PASS} ~${REDIS_PREFIX} -@all +ping +eval +incr +ttl +expire +hello +client|setinfo
ACL
  chown redis:redis "$ACL_FILE"
  chmod 0640 "$ACL_FILE"
  if ! grep -q '^aclfile /etc/redis/users.acl$' /etc/redis/redis.conf; then
    printf '\nbind 127.0.0.1 ::1\nprotected-mode yes\naclfile /etc/redis/users.acl\n' >> /etc/redis/redis.conf
  fi
  systemctl enable --now redis-server
  systemctl restart redis-server

  # Self-test Redis ACL: allowed namespace succeeds, foreign namespace rejected.
  redis-cli --no-auth-warning --user "$REDIS_USER" --pass "$REDIS_PASS" PING | grep -q '^PONG$'
  TEST_KEY="alcor:${INSTANCE_ID}:read-budget:bootstrap-selftest"
  redis-cli --no-auth-warning --user "$REDIS_USER" --pass "$REDIS_PASS" INCR "$TEST_KEY" >/dev/null
  redis-cli --no-auth-warning --user "$REDIS_USER" --pass "$REDIS_PASS" EXPIRE "$TEST_KEY" 5 >/dev/null
  if redis-cli --no-auth-warning --user "$REDIS_USER" --pass "$REDIS_PASS" GET "foreign:denied" >/dev/null 2>&1; then
    echo "Redis ACL self-test failed: foreign key was not rejected." >&2
    exit 1
  fi

  # Write Alcor environment file (0600).
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=3000
FIRE_ENVIRONMENT=production
FIRE_PUBLIC_ORIGIN=https://${DOMAIN}
FIRE_DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}
FIRE_INSTANCE_ID=${INSTANCE_ID}
FIRE_REDIS_URL=redis://${REDIS_USER}:${REDIS_PASS}@127.0.0.1:6379/0
FIRE_BACKUP_DIR=/var/lib/alcor/backups
FIRE_BACKUP_SECRET_DIR=/var/lib/alcor/secrets/backup
FIRE_CONNECTION_SECRET_DIR=/var/lib/alcor/secrets/connections
FIRE_FILE_ROOT=/var/lib/alcor/files
FIRE_ASSET_ROOT=/var/lib/alcor/assets
FIRE_PG_TOOLS_DIR=/usr/lib/postgresql/17/bin
FIRE_NATIVE_LEDGER_ENABLED=1
FIRE_WORKER=on
ENV
  chown alcor:alcor "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
fi

# 6. Install systemd service unit and Caddy reverse proxy config.
cat > /etc/systemd/system/alcor.service <<UNIT
[Unit]
Description=Alcor Investment Platform
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=alcor
Group=alcor
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
RuntimeDirectory=alcor
RuntimeDirectoryMode=0700
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/alcor /run/alcor ${APP_DIR}/.next/cache ${APP_DIR}/public/uploads

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
}
CADDY

systemctl daemon-reload
systemctl enable caddy
systemctl reload caddy || systemctl start caddy

echo "Bootstrap complete. Next steps:"
echo "  1. Clone and build Alcor into ${APP_DIR} as user alcor."
echo "  2. Transfer your migration bundle and run scripts/vps/restore-on-vps.sh."
echo "  3. Start service: sudo systemctl enable --now alcor"
