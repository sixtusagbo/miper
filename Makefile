# Common miper workflows. Run `make` (or `make help`) for the menu.
# Most targets are thin wrappers over npm scripts; the value is the inspect/
# nuke targets that get used between paper-trading runs.

.PHONY: help install build test test-watch typecheck check \
	sim sim-pump sim-pump-fresh snipe-pump snipe-pump-fresh \
	sim-trending sim-trending-fresh review-trending tail-trending \
	archive-trending nuke-trending \
	sim-copytrade sim-copytrade-fresh snipe-copytrade snipe-copytrade-fresh \
	review-copytrade status-copytrade \
	tail-copytrade archive-copytrade nuke-copytrade \
	profile-wallets backtest-discovery backtest-discovery-live \
	sim-discovery sim-discovery-fresh snipe-discovery snipe-discovery-fresh \
	review-discovery status-discovery tail-discovery \
	archive-discovery nuke-discovery \
	monitor-pump status-pump review-pump balance-pump \
	stats-pump scores-pump exits-pump tail-pump \
	archive-pump archive-raydium archive-all \
	nuke-pump nuke-raydium nuke-all clean

# Optional label for archive targets. `make sim-pump-fresh LABEL=R12` puts
# the prior run's DB+log under runs/<UTC-timestamp>_R12/ before launching.
LABEL ?= unlabeled

help:
	@echo "miper — common targets (default goal)"
	@echo ""
	@echo "  Run — paper"
	@echo "    sim-pump-fresh   archive pump state under runs/, then start simulate:pump"
	@echo "                     (pass LABEL=Rxx to tag the archived dir)"
	@echo "    sim-pump         start simulate:pump (keeps existing state)"
	@echo "    sim              start simulate (raydium source)"
	@echo "    sim-trending-fresh  archive trending state, then start simulate:trending"
	@echo "    sim-trending     start simulate:trending (keeps existing state)"
	@echo "    sim-copytrade-fresh archive copytrade state, then start simulate:copytrade"
	@echo "    sim-copytrade    start simulate:copytrade (keeps existing state)"
	@echo "    sim-discovery    start simulate:discovery (alert-only scan of pump launches)"
	@echo ""
	@echo "  Discovery research"
	@echo "    profile-wallets       profile research/target-wallets.txt -> wallet+discovery profile JSONs"
	@echo "    backtest-discovery    replay the scorer over the researched entries (recall sweep)"
	@echo "    backtest-discovery-live  same + live alert precision from discovery.db"
	@echo ""
	@echo "  Run — LIVE (real SOL; needs SIMULATE=false in .env)"
	@echo "    snipe-pump-fresh archive pump state under runs/, then start a live pump run"
	@echo "                     (pass LABEL=Rxx to tag the archived dir)"
	@echo "    snipe-pump       start a live pump run (keeps existing state)"
	@echo ""
	@echo "  Inspect a session (reads pump.log / pump.db)"
	@echo "    stats-pump       pipeline counts (detected/analyzed/skipping/BUYING/exits)"
	@echo "    scores-pump      AI score histogram"
	@echo "    exits-pump       TP1/TP2/TP3/STOPLOSS lines"
	@echo "    tail-pump        live tail of pump.log"
	@echo "    status-pump      open positions in pump.db"
	@echo "    review-pump      PnL + live-readiness summary"
	@echo "    monitor-pump     position monitor only (no new buys)"
	@echo "    balance-pump     wallet balance"
	@echo ""
	@echo "  Develop"
	@echo "    test             vitest run"
	@echo "    test-watch       vitest watch"
	@echo "    typecheck        tsc --noEmit"
	@echo "    check            typecheck + test"
	@echo "    build            tsc"
	@echo "    install          npm install"
	@echo ""
	@echo "  Archive (preserves data — preferred between runs)"
	@echo "    archive-pump     mv pump.db* pump.log* into runs/<stamp>_\$$LABEL/"
	@echo "    archive-raydium  same for sniper.db* / miper.log"
	@echo "    archive-all      both"
	@echo ""
	@echo "  Clean (destructive — only when you really want to delete)"
	@echo "    nuke-pump        rm pump.db* pump.log* (covers WAL sidecars)"
	@echo "    nuke-raydium     rm sniper.db* miper.log"
	@echo "    nuke-all         both"
	@echo "    clean            nuke-all + rm dist coverage"

# ---- run -----------------------------------------------------------------

sim:
	npm run simulate

sim-pump:
	npm run simulate:pump

# Fresh-start: archive the prior run's state, then simulate. Archive (not
# nuke) so the per-run DB and log stay queryable later via SQLite ATTACH
# DATABASE — losing R10a/b/c data after R11 was the lesson here.
sim-pump-fresh: archive-pump
	npm run simulate:pump

# Live pump run — real SOL. SIMULATE=false must be set in .env; --source pump
# is explicit so the run can't silently fall back to the Raydium DB.
snipe-pump:
	npm run snipe:pump

# Fresh live run: archive the prior run's DB+log first, same as sim-pump-fresh.
snipe-pump-fresh: archive-pump
	npm run snipe:pump

# ---- run: trending (GeckoTerminal trending-token strategy) ----------------

sim-trending:
	npm run simulate:trending

sim-trending-fresh: archive-trending
	npm run simulate:trending

review-trending:
	npm run review:trending

tail-trending:
	tail -f trending.log

archive-trending:
	@if [ -f trending.db ] || [ -n "$$(ls trending.log* 2>/dev/null)" ]; then \
		stamp=$$(date -u +%Y-%m-%dT%H-%M-%SZ); \
		dir="runs/$${stamp}_$(LABEL)"; \
		mkdir -p "$$dir"; \
		for f in trending.db trending.db-shm trending.db-wal trending.db-journal trending.log; do \
			[ -e "$$f" ] && mv "$$f" "$$dir/" 2>/dev/null || true; \
		done; \
		for f in trending.log.*; do \
			[ -e "$$f" ] && mv "$$f" "$$dir/" 2>/dev/null || true; \
		done; \
		echo "archived trending state to $$dir"; \
	else \
		echo "no trending state to archive"; \
	fi

nuke-trending:
	rm -f trending.db* trending.log*

# ---- run: copytrade (mirror curated leader wallets) -----------------------

sim-copytrade:
	npm run simulate:copytrade

sim-copytrade-fresh: archive-copytrade
	npm run simulate:copytrade

# Live copytrade run — real SOL. Reads SIMULATE from .env (must be false).
snipe-copytrade:
	npm run snipe:copytrade

snipe-copytrade-fresh: archive-copytrade
	npm run snipe:copytrade

review-copytrade:
	npm run review:copytrade

status-copytrade:
	npm run status:copytrade

tail-copytrade:
	tail -f copytrade.log

archive-copytrade:
	@if [ -f copytrade.db ] || [ -n "$$(ls copytrade.log* 2>/dev/null)" ]; then \
		stamp=$$(date -u +%Y-%m-%dT%H-%M-%SZ); \
		dir="runs/$${stamp}_$(LABEL)"; \
		mkdir -p "$$dir"; \
		for f in copytrade.db copytrade.db-shm copytrade.db-wal copytrade.db-journal copytrade.log; do \
			[ -e "$$f" ] && mv "$$f" "$$dir/" 2>/dev/null || true; \
		done; \
		for f in copytrade.log.*; do \
			[ -e "$$f" ] && mv "$$f" "$$dir/" 2>/dev/null || true; \
		done; \
		echo "archived copytrade state to $$dir"; \
	else \
		echo "no copytrade state to archive"; \
	fi

nuke-copytrade:
	rm -f copytrade.db* copytrade.log*

# ---- run: discovery (scan launches against the researched wallet profile) --

# Research the target wallets (paste addresses into research/target-wallets.txt
# first). Writes research/wallet-profile.json + research/discovery-profile.json.
profile-wallets:
	npm run profile-wallets -- --file research/target-wallets.txt

# Replay the production scorer over the researched entries (recall sweep).
backtest-discovery:
	npm run backtest-discovery -- research/wallet-profile.json

# Same, plus live alert precision from discovery.db.
backtest-discovery-live:
	npm run backtest-discovery -- research/wallet-profile.json --db discovery.db

sim-discovery:
	npm run simulate:discovery

sim-discovery-fresh: archive-discovery
	npm run simulate:discovery

# Live discovery run — real SOL only when SIMULATE=false AND
# DISCOVERY_AUTOBUY=true in .env; otherwise it's an alert-only scan.
snipe-discovery:
	npm run snipe:discovery

snipe-discovery-fresh: archive-discovery
	npm run snipe:discovery

review-discovery:
	npm run review:discovery

status-discovery:
	npm run status:discovery

tail-discovery:
	tail -f discovery.log

archive-discovery:
	@if [ -f discovery.db ] || [ -n "$$(ls discovery.log* 2>/dev/null)" ]; then \
		stamp=$$(date -u +%Y-%m-%dT%H-%M-%SZ); \
		dir="runs/$${stamp}_$(LABEL)"; \
		mkdir -p "$$dir"; \
		for f in discovery.db discovery.db-shm discovery.db-wal discovery.db-journal discovery.log; do \
			[ -e "$$f" ] && mv "$$f" "$$dir/" 2>/dev/null || true; \
		done; \
		for f in discovery.log.*; do \
			[ -e "$$f" ] && mv "$$f" "$$dir/" 2>/dev/null || true; \
		done; \
		echo "archived discovery state to $$dir"; \
	else \
		echo "no discovery state to archive"; \
	fi

nuke-discovery:
	rm -f discovery.db* discovery.log*

# ---- inspect -------------------------------------------------------------

monitor-pump:
	npm run monitor:pump

status-pump:
	npm run status:pump

review-pump:
	npm run review:pump

balance-pump:
	npm run balance:pump

# Pipeline counts from pump.log. Subshell with `|| echo 0` so the target
# prints zeros instead of failing when the log doesn't exist yet.
stats-pump:
	@echo "pipeline counts from pump.log:"
	@printf "  detected:  %s\n" "$$(grep -c 'Pump.fun pool detected' pump.log 2>/dev/null || echo 0)"
	@printf "  analyzed:  %s\n" "$$(grep -cE '^.{12} \[INF\] analyzing' pump.log 2>/dev/null || echo 0)"
	@printf "  skipping:  %s\n" "$$(grep -c 'skipping' pump.log 2>/dev/null || echo 0)"
	@printf "  BUYING:    %s\n" "$$(grep -c 'BUYING' pump.log 2>/dev/null || echo 0)"
	@printf "  exits:     %s\n" "$$(grep -cE 'TP1|TP2|TP3|STOPLOSS' pump.log 2>/dev/null || echo 0)"

scores-pump:
	@grep -oE 'AI scored [^:]+: [0-9]+/100' pump.log 2>/dev/null | grep -oE '[0-9]+/100' | sort -n | uniq -c | sort -rn || true

exits-pump:
	@grep -E 'TP1|TP2|TP3|STOPLOSS' pump.log 2>/dev/null | grep -v 'init match\|parse' || true

tail-pump:
	tail -f pump.log

# ---- develop -------------------------------------------------------------

install:
	npm install

build:
	npm run build

test:
	npm test

test-watch:
	npm run test:watch

typecheck:
	npx tsc --noEmit

check: typecheck test

# ---- archive -------------------------------------------------------------

# Move the current run's DB + log into runs/<UTC-stamp>_<LABEL>/ instead of
# deleting them. Preserves raw per-position timing so future analysis can
# query across runs via SQLite's ATTACH DATABASE. Idempotent: if there's
# nothing to archive (first-ever run or already nuked), just prints a
# notice and exits 0 so dependent targets keep going.
archive-pump:
	@if [ -f pump.db ] || [ -n "$$(ls pump.log* 2>/dev/null)" ]; then \
		stamp=$$(date -u +%Y-%m-%dT%H-%M-%SZ); \
		dir="runs/$${stamp}_$(LABEL)"; \
		mkdir -p "$$dir"; \
		for f in pump.db pump.db-shm pump.db-wal pump.db-journal pump.log; do \
			[ -e "$$f" ] && mv "$$f" "$$dir/" 2>/dev/null || true; \
		done; \
		for f in pump.log.*; do \
			[ -e "$$f" ] && mv "$$f" "$$dir/" 2>/dev/null || true; \
		done; \
		echo "archived pump state to $$dir"; \
	else \
		echo "no pump state to archive"; \
	fi

archive-raydium:
	@if [ -f sniper.db ] || [ -f miper.log ]; then \
		stamp=$$(date -u +%Y-%m-%dT%H-%M-%SZ); \
		dir="runs/$${stamp}_$(LABEL)"; \
		mkdir -p "$$dir"; \
		for f in sniper.db sniper.db-shm sniper.db-wal sniper.db-journal miper.log; do \
			[ -e "$$f" ] && mv "$$f" "$$dir/" 2>/dev/null || true; \
		done; \
		echo "archived raydium state to $$dir"; \
	else \
		echo "no raydium state to archive"; \
	fi

archive-all: archive-pump archive-raydium

# ---- clean ---------------------------------------------------------------

# `*` covers the WAL/SHM sidecars left when SQLite is killed mid-run.
# Prefer archive-pump — these targets exist for when you really mean delete.
nuke-pump:
	rm -f pump.db* pump.log*

nuke-raydium:
	rm -f sniper.db* miper.log

nuke-all: nuke-pump nuke-raydium

clean: nuke-all
	rm -rf dist coverage
