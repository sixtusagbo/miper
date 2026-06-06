#!/usr/bin/env bash
# One-time system setup for a fresh Ubuntu 24.04 Hetzner Cloud box.
# Run as root on the server:  bash provision.sh
#
# Installs Node 22, build tools (better-sqlite3 compiles natively), git, and a
# firewall, then creates an unprivileged 'miper' user to run the bot. It does
# NOT clone the repo or touch secrets; the README walks those steps as the
# miper user so the wallet key never lands in a root-owned file.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade -y
# build-essential + python3 are node-gyp's toolchain for better-sqlite3.
apt-get install -y curl git ufw build-essential python3

# Node 22 LTS from NodeSource (matches the dev machine's major).
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "node $(node -v), npm $(npm -v)"

# Outbound-only bot: deny all inbound except SSH.
ufw allow OpenSSH
ufw --force enable

# Unprivileged service account. No password; you reach it via 'sudo -iu miper'.
if ! id miper >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" miper
fi

echo
echo "system ready. next: follow deploy/README.md as the miper user."
