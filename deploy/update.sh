#!/usr/bin/env bash
# Pull the latest copy-trading code, rebuild, and restart the bot.
# Run as the miper user:  bash ~/miper/deploy/update.sh
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

git fetch origin
git checkout copy-trading
git pull --ff-only origin copy-trading

npm ci
npm run build

# Restart the service (needs a one-time sudoers entry; see README).
sudo systemctl restart miper-copytrade
echo "restarted. tail logs with: journalctl -fu miper-copytrade"
