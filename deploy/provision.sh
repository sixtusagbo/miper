#!/usr/bin/env bash
# One-time system setup + hardening for a fresh Ubuntu 24.04 Hetzner Cloud box.
# Run as root on the server:  bash provision.sh
#
# This box will hold a live wallet private key, so it is hardened: key-only SSH,
# no root password login, brute-force protection, automatic security updates,
# and an inbound-deny firewall. It installs the Node toolchain and creates an
# unprivileged 'miper' user, but does NOT clone the repo or touch secrets; the
# README does those as the miper user so the key never lands in a root file.
#
# IMPORTANT: connect with an SSH key before running this. It disables password
# logins, so a password-only session would lock you out.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
# Ubuntu 24.04 ships needrestart, which can open an interactive whiptail prompt
# during library upgrades that DEBIAN_FRONTEND alone does not suppress, hanging
# the (set -e) provision. Force it fully automatic.
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

# --- packages -------------------------------------------------------------
apt-get update
apt-get upgrade -y
# build-essential + python3 are node-gyp's toolchain for better-sqlite3.
apt-get install -y curl git ufw build-essential python3 fail2ban unattended-upgrades

# Node 22 LTS from NodeSource (matches the dev machine's major).
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "node $(node -v), npm $(npm -v)"

# --- firewall: outbound-only bot, deny all inbound except SSH -------------
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

# --- SSH hardening: key-only, no password, no root password login --------
# Guard against lockout: only disable password auth if a key is already
# authorized for root (i.e. you connected with a key, as instructed).
if [ -s /root/.ssh/authorized_keys ]; then
  cat > /etc/ssh/sshd_config.d/99-miper-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  if sshd -t; then
    systemctl reload ssh
    echo "SSH hardened: password auth off, root key-only."
  else
    echo "WARNING: sshd config test failed; left SSH unchanged." >&2
    rm -f /etc/ssh/sshd_config.d/99-miper-hardening.conf
  fi
else
  echo "WARNING: no /root/.ssh/authorized_keys found. Skipping SSH password" >&2
  echo "         lockdown so you are not locked out. Add a key, then set" >&2
  echo "         PasswordAuthentication no manually." >&2
fi

# --- brute-force protection on SSH ---------------------------------------
cat > /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 4
bantime = 1h
EOF
systemctl enable fail2ban
systemctl restart fail2ban
# Verify the jail actually came up watching sshd (a misconfigured backend can
# leave fail2ban "running" but banning nothing).
if fail2ban-client status sshd >/dev/null 2>&1; then
  echo "fail2ban sshd jail active."
else
  echo "WARNING: fail2ban sshd jail is NOT active — check 'fail2ban-client status'." >&2
fi

# --- automatic security updates ------------------------------------------
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Activate the unattended-upgrades unit and prove it can resolve allowed
# origins (installing the package + writing the timer config is not enough).
systemctl enable --now unattended-upgrades 2>/dev/null || true
if unattended-upgrade --dry-run >/dev/null 2>&1; then
  echo "unattended-upgrades active."
else
  echo "WARNING: unattended-upgrades dry-run failed — security patches may not apply." >&2
fi

# --- unprivileged service account ----------------------------------------
# Password-disabled and NOT in sudo: reached via 'sudo -iu miper' from root.
# update.sh gets one narrow systemctl-restart sudoers grant (see README).
if ! id miper >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" miper
fi
# Lock down the home dir so a (future) other unprivileged account can't read
# the wallet key in ~/miper/.env.
chmod 700 /home/miper

echo
echo "system ready and hardened. next: follow deploy/README.md as the miper user."
