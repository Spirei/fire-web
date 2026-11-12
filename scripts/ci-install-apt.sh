#!/usr/bin/env bash
# Ubuntu CI only. Invoke with sudo; leave the runner's configured sources intact.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: bash scripts/ci-install-apt.sh PACKAGE..." >&2
  exit 2
fi

missing=()
for package in "$@"; do
  if [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]; then
    missing+=("$package")
  fi
done
if [ "${#missing[@]}" -eq 0 ]; then
  echo "CI runtime packages are already installed."
  exit 0
fi

apt_options=(
  -o Acquire::Retries=2
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
  # apt-get update otherwise returns success when indexes fail to download.
  -o APT::Update::Error-Mode=any
)
install_packages() {
  local options=("${apt_options[@]}" "$@")
  # Per-connection timeouts do not bound many slow index/download requests.
  # Bound one complete mirror attempt, including its child apt/dpkg processes.
  timeout --kill-after=15s 300s bash -c '
    count=$1
    shift
    options=("${@:1:count}")
    shift "$count"
    apt-get "${options[@]}" update &&
      apt-get "${options[@]}" install -y --no-install-recommends "$@"
  ' ci-apt-attempt "${#options[@]}" "${options[@]}" "${missing[@]}"
}

codename=$(lsb_release -cs)
architecture=$(dpkg --print-architecture)
if [[ ! "$codename" =~ ^[a-z]+$ ]] || [ "$architecture" != amd64 ]; then
  echo "Unsupported Ubuntu CI release or architecture." >&2
  exit 1
fi

sources_dir=$(mktemp -d)
trap 'rm -rf "$sources_dir"' EXIT
chmod 755 "$sources_dir"

# Bypass the runner's mirror+file redirects. Kernel.org mirrors the same signed
# Ubuntu archive on an independent domain (including the security pocket).
for mirror in ubuntu kernel; do
  if [ "$mirror" = ubuntu ]; then
    archive=https://archive.ubuntu.com/ubuntu
    security=https://security.ubuntu.com/ubuntu
    hosts=(archive.ubuntu.com security.ubuntu.com)
  else
    archive=https://mirrors.edge.kernel.org/ubuntu
    security=$archive
    hosts=(mirrors.edge.kernel.org)
  fi
  reachable=true
  for host in "${hosts[@]}"; do
    if ! timeout 10s getent ahostsv4 "$host" >/dev/null; then
      echo "::warning::Cannot resolve $host; trying the next Ubuntu archive mirror."
      reachable=false
      break
    fi
  done
  if [ "$reachable" = false ]; then
    continue
  fi

  echo "Installing CI runtime packages from $archive"
  mkdir -p "$sources_dir/$mirror-lists/partial"
  cat > "$sources_dir/$mirror.list" <<EOF
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $archive $codename main restricted universe multiverse
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $archive $codename-updates main restricted universe multiverse
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $security $codename-security main restricted universe multiverse
EOF

  # Isolate each mirror's indexes; never reuse stale lists or bypass signatures.
  if install_packages \
    -o "Dir::Etc::sourcelist=$sources_dir/$mirror.list" \
    -o Dir::Etc::sourceparts=- \
    -o "Dir::State::lists=$sources_dir/$mirror-lists"; then
    exit 0
  fi
  echo "::warning::Installation from $archive failed; trying the next Ubuntu archive mirror."
done
echo 'All Ubuntu archive mirrors failed; CI runtime packages were not installed.' >&2
exit 100
