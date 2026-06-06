#!/usr/bin/env bash
# Telegram alert sent when a miper systemd unit enters the failed state.
# Invoked by the unit's OnFailure=miper-alert@%n.service. Reads the bot's own
# .env for the Telegram creds. Best-effort: never fails hard, never blocks.
set -uo pipefail

ENV_FILE="/home/miper/miper/.env"
UNIT="${1:-miper}"

[ -r "$ENV_FILE" ] || exit 0
TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
CHAT=$(grep -E '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2-)
[ -n "$TOKEN" ] && [ -n "$CHAT" ] || exit 0

curl -s -m 10 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="${CHAT}" \
  -d text="[miper] UNIT FAILED: ${UNIT} entered the failed state. Check: journalctl -u ${UNIT}" \
  >/dev/null 2>&1 || true
exit 0
