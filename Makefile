# Common miper workflows. Run `make` (or `make help`) for the menu.
# Most targets are thin wrappers over npm scripts; the value is the inspect/
# nuke targets that get used between paper-trading runs.

.PHONY: help install build test test-watch typecheck check \
	sim sim-pump sim-pump-fresh \
	monitor-pump status-pump review-pump balance-pump \
	stats-pump scores-pump exits-pump tail-pump \
	nuke-pump nuke-raydium nuke-all clean

help:
	@echo "miper — common targets (default goal)"
	@echo ""
	@echo "  Run"
	@echo "    sim-pump-fresh   nuke pump state, then start simulate:pump"
	@echo "    sim-pump         start simulate:pump (keeps existing state)"
	@echo "    sim              start simulate (raydium source)"
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
	@echo "  Clean"
	@echo "    nuke-pump        rm pump.db* pump.log* (covers WAL sidecars)"
	@echo "    nuke-raydium     rm sniper.db* miper.log"
	@echo "    nuke-all         both"
	@echo "    clean            nuke-all + rm dist coverage"

# ---- run -----------------------------------------------------------------

sim:
	npm run simulate

sim-pump:
	npm run simulate:pump

# Fresh-start: clean state then simulate. The most common pre-run flow.
sim-pump-fresh: nuke-pump
	npm run simulate:pump

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

# ---- clean ---------------------------------------------------------------

# `*` covers the WAL/SHM sidecars left when SQLite is killed mid-run.
nuke-pump:
	rm -f pump.db* pump.log*

nuke-raydium:
	rm -f sniper.db* miper.log

nuke-all: nuke-pump nuke-raydium

clean: nuke-all
	rm -rf dist coverage
