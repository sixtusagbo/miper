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

Create the file already private (so the live key is never in a world-readable
file during the edit), then fill it in:

```
install -m 600 /dev/null .env
cat .env.example >> .env
nano .env
```

Set at least:

- `SOURCE=copytrade`
- `SIMULATE=false`
- `WALLET_PRIVATE_KEY=` the copy-trading wallet `EcehC76ATmta8RBiYnMwSTDTGYCxSzodCq7XQbeBuQL2`, funded with ~0.5 SOL
- `SOLANA_RPC_URL=` your Helius URL (the trade-confirmation WebSocket is derived from it)
- `COPYTRADE_WALLETS=` the vetted leader addresses (comma-separated)
- No AI key is needed for copytrade.

Exposure and exit policy (keep peak exposure under ~60% of funding so there's
gas/rent headroom):

- `BUY_AMOUNT_SOL=0.05` and `MAX_OPEN_POSITIONS=5` -> 0.25 SOL peak on 0.5 funded
- `CLOSE_ON_SHUTDOWN=false` (so an `update.sh` restart does NOT market-sell the
  whole book; positions persist in the DB and the monitor resumes them)
- `MAX_HOLD_MINUTES=720` as a time floor for a leader who never sells
- `STOP_LOSS=0.4` stays as the loss floor
- `MAX_RUN_HOURS=0` (run unbounded; systemd manages restarts)

Optional alerting (recommended, free): set `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` for startup / circuit-breaker / no-activity pushes.

Sanity-check the wallet the bot actually resolves before going live:

```
node dist/index.js balance --source copytrade
```

The printed address MUST be `EcehC76...`. If it is not, a stale env var is
overriding `.env`; fix it before starting. Confirm the printed balance is the
~0.5 SOL you funded and that the wallet has no large leftover token bags.

## 4. Install the service (as root)

Install both the bot unit and the failure-alert helper (so a hard crash pushes
a Telegram alert via the unit's `OnFailure`):

```
cp /home/miper/miper/deploy/miper-copytrade.service /etc/systemd/system/
cp /home/miper/miper/deploy/miper-alert@.service /etc/systemd/system/
chmod +x /home/miper/miper/deploy/alert-failure.sh
systemctl daemon-reload
systemctl enable --now miper-copytrade
journalctl -fu miper-copytrade
```

The banner's `wallet:` line must show `EcehC76...`. If it does not, stop the
service and fix `.env`. A clean boot also pushes a Telegram "started" alert if
Telegram is configured.

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

## Monitoring

- The bot pushes Telegram alerts on startup, a tripped circuit breaker, and a
  no-leader-activity heartbeat (if `TELEGRAM_*` are set).
- A hard crash that puts the unit in the failed state fires `OnFailure` ->
  `miper-alert@.service` -> a Telegram "unit failed" push.
- The circuit breaker exits code 2 and the unit's `RestartPreventExitStatus=2`
  keeps it down (it does not auto-restart into the same fault). A real
  crash-loop trips the `StartLimit` and stops, rather than looping silently.
- Watch logs anytime: `journalctl -fu miper-copytrade`.

## Security notes

- Hardening is applied by `provision.sh`: key-only SSH (no passwords), root
  login key-only, `fail2ban` (verified), automatic security updates (verified),
  inbound-deny firewall, `/home/miper` chmod 700.
- The systemd unit is sandboxed: `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome=read-only` (+ `ReadWritePaths`), `PrivateTmp`, dropped caps.
- The wallet key lives only in `~/miper/.env` (created 600), owned by miper.
- `miper` is not in `sudo`; it gets one narrow grant to restart the service.
- Deploy key is read-only, so a server compromise cannot push to the repo.
- The bot is outbound-only; nothing listens for inbound connections.
- Never commit `.env`. It is gitignored.

The box is a hot wallet: the key is plaintext in `.env` on a shared-CPU VPS, so
fund `EcehC76...` with only the validation amount and keep it separate from any
wallet holding real balance. On a suspected breach: revoke the GitHub deploy
key, move the funds, and rebuild the box.
