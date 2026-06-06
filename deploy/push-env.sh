#!/usr/bin/env bash
# Push the local prod env to the server and restart the bot.
#
# Source of truth is .env.prod on the Mac (gitignored, full secrets). The
# server's ~/miper/.env is just a copy of it. Edit .env.prod locally, then:
#   bash deploy/push-env.sh [ssh-host]    (default host: miper.server)
#
# Requires root SSH to the box via the admin key (the ssh-config alias added
# after provisioning). Installs the file with miper ownership + 600 and
# restarts the unit; with CLOSE_ON_SHUTDOWN=false that restart does not dump
# open positions.
set -euo pipefail

HOST="${1:-miper.server}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/.env.prod"

[ -f "$SRC" ] || { echo "missing $SRC (create it from .env.example)" >&2; exit 1; }

# Guardrails: never push a paper-mode or placeholder config to a live box.
grep -qE '^SIMULATE=false[[:space:]]*$' "$SRC" || {
  echo "refusing: SIMULATE is not false in .env.prod" >&2; exit 1; }
grep -qE '^WALLET_PRIVATE_KEY=.{20}' "$SRC" || {
  echo "refusing: WALLET_PRIVATE_KEY looks unset in .env.prod" >&2; exit 1; }
grep -qE '^SOLANA_RPC_URL=https?://.' "$SRC" || {
  echo "refusing: SOLANA_RPC_URL looks unset in .env.prod" >&2; exit 1; }
grep -qE '^COPYTRADE_WALLETS=[1-9A-HJ-NP-Za-km-z]' "$SRC" || {
  echo "refusing: COPYTRADE_WALLETS is empty in .env.prod" >&2; exit 1; }

echo "pushing .env.prod -> ${HOST}:~/miper/.env"
scp "$SRC" "root@${HOST}:/tmp/miper.env"
ssh "root@${HOST}" '
  install -o miper -g miper -m 600 /tmp/miper.env /home/miper/miper/.env &&
  rm -f /tmp/miper.env &&
  systemctl restart miper-copytrade &&
  echo "env installed + service restarted"
'
echo "done. verify the LIVE banner + wallet: ssh ${HOST} journalctl -fu miper-copytrade"
