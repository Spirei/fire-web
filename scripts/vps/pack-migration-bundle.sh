#!/usr/bin/env bash
# Pack a consistent single-PG + 4-private-dir migration bundle from Synology Docker or bare-metal.
set -euo pipefail

CONTAINER=""
ENV_FILE=""
OUT_DIR=""

usage() {
  cat <<'EOF'
Usage:
  # From Synology Docker container:
  sudo bash scripts/vps/pack-migration-bundle.sh --container fire --out /tmp/alcor-migration-bundle

  # From bare-metal host:
  sudo bash scripts/vps/pack-migration-bundle.sh --env-file /etc/alcor/alcor.env --out /tmp/alcor-migration-bundle
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$OUT_DIR" || ( -z "$CONTAINER" && -z "$ENV_FILE" ) || ( -n "$CONTAINER" && -n "$ENV_FILE" ) ]]; then
  usage
  exit 1
fi

install -d -m 0700 "$OUT_DIR"

if [[ -n "$CONTAINER" ]]; then
  echo "[1/3] Exporting PostgreSQL custom dump from container '${CONTAINER}'..."
  docker exec "$CONTAINER" sh -c 'pg_dump -Fc --no-owner --no-privileges "$FIRE_DATABASE_URL"' > "${OUT_DIR}/database.dump"

  echo "[2/3] Packing 4 required private directories (excluding disk migration archives)..."
  for pair in \
    "backup-secrets:FIRE_BACKUP_SECRET_DIR" \
    "connection-secrets:FIRE_CONNECTION_SECRET_DIR" \
    "files:FIRE_FILE_ROOT" \
    "assets:FIRE_ASSET_ROOT"
  do
    archive_name="${pair%%:*}"
    env_var="${pair##*:}"
    docker exec "$CONTAINER" sh -c "
      dir=\"\${${env_var}:-}\"
      if [ -n \"\$dir\" ] && [ -d \"\$dir\" ]; then
        tar -C \"\$dir\" -czf - .
      else
        exit 3
      fi
    " > "${OUT_DIR}/${archive_name}.tar.gz" || {
      rc=$?
      if [[ $rc -eq 3 ]]; then
        rm -f "${OUT_DIR}/${archive_name}.tar.gz"
        echo "  - Skipped ${archive_name} (${env_var} not configured or missing)"
      else
        exit "$rc"
      fi
    }
  done
else
  # shellcheck disable=SC1090
  set -a && source "$ENV_FILE" && set +a
  echo "[1/3] Exporting PostgreSQL custom dump..."
  pg_dump -Fc --no-owner --no-privileges "$FIRE_DATABASE_URL" > "${OUT_DIR}/database.dump"

  echo "[2/3] Packing 4 required private directories..."
  for pair in \
    "backup-secrets:FIRE_BACKUP_SECRET_DIR" \
    "connection-secrets:FIRE_CONNECTION_SECRET_DIR" \
    "files:FIRE_FILE_ROOT" \
    "assets:FIRE_ASSET_ROOT"
  do
    archive_name="${pair%%:*}"
    env_var="${pair##*:}"
    dir="${!env_var:-}"
    if [[ -n "$dir" && -d "$dir" ]]; then
      tar -C "$dir" -czf "${OUT_DIR}/${archive_name}.tar.gz" .
    else
      echo "  - Skipped ${archive_name} (${env_var} not configured or missing)"
    fi
  done
fi

echo "[3/3] Generating SHA256SUMS manifest..."
(
  cd "$OUT_DIR"
  rm -f SHA256SUMS
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum database.dump ./*.tar.gz 2>/dev/null | sed 's| \./| |' > SHA256SUMS
  else
    shasum -a 256 database.dump ./*.tar.gz 2>/dev/null | sed 's| \./| |' > SHA256SUMS
  fi
)
chmod 0600 "${OUT_DIR}"/*

echo "Migration bundle ready at: ${OUT_DIR}"
echo "Transfer with: rsync -avz --progress ${OUT_DIR}/ root@<new-vps-ip>:/root/alcor-migration-bundle/"
