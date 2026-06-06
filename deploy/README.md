# Deploying the copy-trading bot

Target: a fresh Hetzner Cloud CX23 (2 vCPU, IPv4 on), Ubuntu 24.04, SSH-key
auth. The bot is one Node process managed by systemd, so it restarts on crash
and on reboot. No tmux, no caffeinate.

## How git auth works on the server (no GitHub Actions)

The server pulls code with a read-only **SSH deploy key**, generated on the box
in step 2 and added to the repo. `git clone` uses the SSH remote, and
`update.sh` reuses the same key for `git fetch`/`git pull`. Two separate keys
are in play:

- `~/.ssh/miper` on your Mac: admin access (Mac -> server), passphrase-protected.
- the server's `~/.ssh/id_ed25519`: read-only deploy key (server -> GitHub), no
  passphrase so updates run non-interactively.

A server breach therefore cannot push to the repo (read-only) and cannot reach
GitHub beyond this one repo.

## 0. Before you touch the server (on your Mac)

Push the branch (the server clones from `origin`):

```
git push origin copy-trading
```

Confirm `origin/copy-trading` includes the mayhem veto and the trader fixes.

Then generate the admin SSH key and grab its public half to attach at box
creation:

```
bash deploy/mac-prep.sh
```

This writes `~/.ssh/miper` (passphrase-protected) and prints the public key to
paste into Hetzner's "SSH keys" section when you create the box.

## 1. System setup (as root on the server)

Create the Hetzner box with your **SSH key attached** (not password). The
script disables password logins, so a password-only session would lock you
out.

```
scp deploy/provision.sh root@SERVER_IP:/root/
ssh root@SERVER_IP
bash provision.sh
```

Installs Node 22 and build tools, creates the unprivileged `miper` user, and
hardens the box (it will hold a live wallet key):

- key-only SSH, password auth off, root login key-only
- `fail2ban` brute-force protection on SSH
- automatic security updates (`unattended-upgrades`)
- firewall: deny all inbound except SSH, allow outbound

If the script warns that no root key was found, it skips the SSH password
lockdown to avoid locking you out. Add your key, then set
`PasswordAuthentication no` yourself before going live.

## 2. Clone the repo (as the miper user)

A private repo needs a read-only deploy key.

```
sudo -iu miper
ssh-keygen -t ed25519 -C "miper-server" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Add that public key as a **deploy key** on the repo:
GitHub > repo > Settings > Deploy keys > Add deploy key (read access only).
Then:

```
git clone git@github.com:sixtusagbo/miper.git ~/miper
cd ~/miper
git checkout copy-trading
npm ci
npm run build
```

## 3. Configure (as the miper user)

```
cp .env.example .env
nano .env
chmod 600 .env
```

Set at least:

- `SOURCE=copytrade`
- `SIMULATE=false`
- `WALLET_PRIVATE_KEY=` the copy-trading wallet (`HFQJHZd2n5...`), funded with 0.5 SOL
- `SOLANA_RPC_URL=` your Helius URL
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` as needed
- `COPYTRADE_WALLETS=` the leaders
- `BUY_AMOUNT_SOL`, `MAX_OPEN_POSITIONS`, exit knobs as desired

Sanity-check the wallet the bot actually resolves before going live:

```
node dist/index.js balance --source copytrade
```

The printed address must be the copy-trading wallet. If it is not, a stale env
var is overriding `.env`; fix it before starting.

## 4. Install the service (as root)

```
cp /home/miper/miper/deploy/miper-copytrade.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now miper-copytrade
journalctl -fu miper-copytrade
```

The banner's `wallet:` line must show the copy-trading wallet. If it does not,
stop the service and fix `.env`.

## 5. Let miper restart the service without a root password

So `update.sh` can restart without full sudo, add one sudoers line (as root):

```
echo 'miper ALL=(root) NOPASSWD: /usr/bin/systemctl restart miper-copytrade' \
  > /etc/sudoers.d/miper-restart
chmod 440 /etc/sudoers.d/miper-restart
```

## Day-to-day

- Logs: `journalctl -fu miper-copytrade` (or the app's own `copytrade.log`)
- Update to latest code: `bash ~/miper/deploy/update.sh` (as miper)
- Stop: `sudo systemctl stop miper-copytrade`
- Status: `systemctl status miper-copytrade`

## Security notes

- Hardening is applied by `provision.sh`: key-only SSH (no passwords), root
  login key-only, `fail2ban`, automatic security updates, inbound-deny firewall.
- The wallet key lives only in `~/miper/.env` (chmod 600), owned by miper.
- `miper` is not in `sudo`; it gets one narrow grant to restart the service.
- Deploy key is read-only, so a server compromise cannot push to the repo.
- The bot is outbound-only; nothing listens for inbound connections.
- Never commit `.env`. It is gitignored.

Optional extra: fund the wallet with only what you can lose, and treat the box
as compromised-able. If the server is breached the key is exposed, so keep the
copy-trading wallet separate from any wallet holding meaningful balance.
