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
  apt-get "${apt_options[@]}" "$@" update &&
    apt-get "${apt_options[@]}" "$@" install -y --no-install-recommends "${missing[@]}"
}

if install_packages; then
  exit 0
fi

echo '::warning::Runner package mirror failed; retrying with direct Ubuntu HTTPS sources.'
codename=$(lsb_release -cs)
architecture=$(dpkg --print-architecture)
if [[ ! "$codename" =~ ^[a-z]+$ ]] || [ "$architecture" != amd64 ]; then
  echo "Unsupported Ubuntu CI release or architecture." >&2
  exit 1
fi

sources_dir=$(mktemp -d)
trap 'rm -rf "$sources_dir"' EXIT
chmod 755 "$sources_dir"
mkdir -p "$sources_dir/lists/partial"
cat > "$sources_dir/sources.list" <<EOF
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu $codename main restricted universe multiverse
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu $codename-updates main restricted universe multiverse
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu $codename-security main restricted universe multiverse
EOF

# Isolate both sources and indexes: no mirror+file redirects or stale runner lists.
# Keep Ubuntu's archive signature verification enabled for every fallback package.
install_packages \
  -o "Dir::Etc::sourcelist=$sources_dir/sources.list" \
  -o Dir::Etc::sourceparts=- \
  -o "Dir::State::lists=$sources_dir/lists"
