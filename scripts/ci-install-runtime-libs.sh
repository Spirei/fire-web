#!/bin/sh
set -eu

# GitHub's Azure mirror can stall all shards before tests start. Keep Ubuntu's
# signed archive and packages, using its official HTTPS endpoint instead.
for source in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
  if [ -f "$source" ]; then
    sudo sed -i -e 's#mirror+file:/etc/apt/apt-mirrors.txt#https://archive.ubuntu.com/ubuntu/#g' \
      -e 's#http[s]*://azure.archive.ubuntu.com/ubuntu/#https://archive.ubuntu.com/ubuntu/#g' "$source"
  fi
done
sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 -o APT::Update::Error-Mode=any update
sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 install -y "$@"
