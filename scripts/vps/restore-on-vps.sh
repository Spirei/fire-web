#!/usr/bin/env bash
# Verify SHA256SUMS, restore single PG database + 4 private dirs on bare-metal VPS, and preflight schema.
set -euo pipefail

BUNDLE_DIR=""
ENV_FILE="/etc/alcor/alcor.env"
APP_DIR="/opt/alcor/app"
RUN_USER="alcor"

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/vps/restore-on-vps.sh \
    --bundle-dir /root/alcor-migration-bundle \
    [--env-file /etc/alcor/alcor.env] \
    [--app-dir /opt/alcor/app]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-dir) BUNDLE_DIR="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi
if [[ -z "$BUNDLE_DIR" || ! -f "${BUNDLE_DIR}/SHA256SUMS" || ! -f "${BUNDLE_DIR}/database.dump" ]]; then
  echo "Valid --bundle-dir containing SHA256SUMS and database.dump is required." >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

echo "[1/5] Verifying bundle integrity (SHA256SUMS)..."
(cd "$BUNDLE_DIR" && sha256sum -c SHA256SUMS)

echo "[2/5] Stopping alcor service (if active)..."
systemctl stop alcor 2>/dev/null || true

# shellcheck disable=SC1090
set -a && source "$ENV_FILE" && set +a

echo "[3/5] Restoring single PostgreSQL database..."
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --dbname "$FIRE_DATABASE_URL" \
  "${BUNDLE_DIR}/database.dump"

echo "[4/5] Restoring private directories and enforcing 0700/0600 permissions..."
for pair in \
  "backup-secrets:FIRE_BACKUP_SECRET_DIR:secret" \
  "connection-secrets:FIRE_CONNECTION_SECRET_DIR:secret" \
  "files:FIRE_FILE_ROOT:data" \
  "assets:FIRE_ASSET_ROOT:data"
do
  IFS=':' read -r archive_name env_var kind <<< "$pair"
  archive_path="${BUNDLE_DIR}/${archive_name}.tar.gz"
  target_dir="${!env_var:-}"
  if [[ -f "$archive_path" && -n "$target_dir" ]]; then
    install -d -o "$RUN_USER" -g "$RUN_USER" -m 0700 "$target_dir"
    tar -C "$target_dir" -xzf "$archive_path"
    chown -R "${RUN_USER}:${RUN_USER}" "$target_dir"
    chmod 0700 "$target_dir"
    if [[ "$kind" == "secret" ]]; then
      find "$target_dir" -type d -exec chmod 0700 {} +
      find "$target_dir" -type f -exec chmod 0600 {} +
    fi
  fi
done

echo "[5/5] Verifying configuration, instance UUID, and schema migrations..."
su -s /bin/bash "$RUN_USER" -c "
  set -euo pipefail
  cd '${APP_DIR}'
  set -a && source '${ENV_FILE}' && set +a
  npm run platform:config
  npm run platform:check
"

echo "Restore verified! Start service with:"
echo "  sudo systemctl enable --now alcor"
echo "  curl -fsS http://127.0.0.1:3000/health/ready"
