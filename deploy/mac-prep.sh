#!/usr/bin/env bash
# Mac-side prep, run ONCE on your Mac before creating the Hetzner box:
#   bash deploy/mac-prep.sh
#
# Generates a fresh, dedicated, passphrase-protected SSH key for admin access
# to the miper server (Mac -> server root login), then prints the public key
# to paste into Hetzner's "SSH keys" section during box creation.
#
# This is NOT the GitHub deploy key. That one is generated on the server later
# (see README step 2) and is read-only, server -> GitHub.
set -euo pipefail

KEY="$HOME/.ssh/miper"

if [ -f "$KEY" ]; then
  echo "key already exists at $KEY, not overwriting."
else
  # ed25519, 100 KDF rounds (slows brute-force if the private key is stolen).
  # You will be prompted for a passphrase twice. Set a real one: this key
  # guards admin access to a box holding a live wallet key. Do not leave empty.
  ssh-keygen -t ed25519 -a 100 -C "miper-hetzner" -f "$KEY"
fi

echo
echo "=== PUBLIC KEY: paste this into Hetzner > SSH keys during box creation ==="
cat "$KEY.pub"
echo "========================================================================"
echo
echo "Next: create the box with this key attached, then send the server IP so"
echo "the ~/.ssh/config 'miper.server' alias can be added."
