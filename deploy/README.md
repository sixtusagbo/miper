# Deploying the copy-trading bot

Target: a fresh Hetzner Cloud CX23 (2 vCPU, IPv4 on), Ubuntu 24.04, SSH-key
auth. The bot is one Node process managed by systemd, so it restarts on crash
and on reboot. No tmux, no caffeinate.

## 0. Before you touch the server (on your Mac)

The server clones from `origin`, so push the branch first:

```
git push origin copy-trading
```

Confirm `origin/copy-trading` includes the mayhem veto and the trader fixes.

## 1. System setup (as root on the server)

```
scp deploy/provision.sh root@SERVER_IP:/root/
ssh root@SERVER_IP
bash provision.sh
```

Installs Node 22, build tools, a firewall (SSH-only inbound), and creates the
unprivileged `miper` user.

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

- The wallet key lives only in `~/miper/.env` (chmod 600), owned by miper.
- Deploy key is read-only, so a server compromise cannot push to the repo.
- Firewall denies all inbound except SSH; the bot is outbound-only.
- Never commit `.env`. It is gitignored.
