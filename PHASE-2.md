# Pump.fun Phase 2 — Go-Live Prompt

Feed this to Claude Code when you're ready to build out live pump.fun trading. It is self-contained; the model does not need prior conversation context.

---

## Prompt to paste

I'm ready to take pump.fun support from paper-only to live. Phase 1 (on the `pump-fun` branch, merged or not — check `git log`) shipped the listener, analyzer, Token-2022 handling, propagation retries, synthetic market data, and paper-only buys/sells. Phase 2 is the real execution and price-tracking layer.

Before touching code, read:

- `src/analyzer.ts` — note the pump-specific paths (`pumpMarketData`, `getMintAcrossPrograms`, the `cfg.source === 'pump'` skips)
- `src/trader.ts` — note `pumpBuy` and `pumpSell`; both return an error when `!cfg.simulate`
- `src/positions.ts` — note `fetchPriceSol` is DexScreener-only
- `src/listener.ts` — note `PumpListener` and `parsePumpMintFromSignature` already emit the right mint, bonding curve PDA, and creator's initial SOL deposit
- `README.md` — the token-sources section explains the current phase-1 boundary

### What needs to ship

1. **Live pump buy via direct bonding-curve instruction.** Jupiter V6 will not route fresh pump launches; replace the `pumpBuy` live-mode stub with a signed transaction against the pump.fun program. Constant-product math with the global virtual reserves (30 virtual SOL / 1.073B virtual tokens at launch, then shifted by real buys/sells). Program ID: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`. Instruction is `buy` — `fee_recipient`, `mint`, `bonding_curve`, `associated_bonding_curve`, `associated_user`, `user`, and the standard system/token/event-authority accounts. Include slippage protection using `cfg.maxSlippageBps`.

2. **Live pump sell via direct bonding-curve instruction.** Same program, `sell` instruction, similar account layout. Note that once a pump token graduates (~85 real SOL in the curve) it moves to PumpSwap AMM (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`). For graduated tokens, Jupiter routes fine — fall back to the existing Jupiter path when the bonding curve account no longer exists or reports graduation.

3. **Real-time bonding-curve price polling.** DexScreener does not index pump tokens until well after they move; the current `fetchPriceSol` returns `null` for ~every fresh pump token, so TP/SL never fire. Add a pump-native price source that reads the bonding curve account directly (`getAccountInfo` → decode virtual + real reserves → compute current price in SOL). When `cfg.source === 'pump'` and the position has a pump `pool_address`, prefer this path over DexScreener. Poll interval can stay at the current 7s.

4. **Remove the phase-1 guards.** Drop the `PUMP_LIVE_NOT_SUPPORTED` error and the README/ENV comments that say pump is paper-only. Update `analyzer.ts` comment on `pumpMarketData` since DexScreener is no longer our only hope.

### Only after 1-3 are working, consider

5. **Risk-level abstraction.** A `RISK_LEVEL=high|low` env (or `--risk` flag) that maps to `MIN_AI_SCORE` + TP multipliers:
   - `low`: score ≥ 70, TPs 2x/3x/5x (current defaults)
   - `high`: score ≥ 30, flat 2x exit (all three TPs collapsed to 2x, aggressive compounding)
   - Wire it through `Config`, surface in the banner, document in README.

Do not build step 5 until steps 1-3 produce real paper-trade PnL backed by live bonding-curve prices. Without real price movement data, the risk-level experiment is fiction.

### Constraints and guardrails

- Atomic commits, one logical change per commit. Subjects capitalized, no `feat:` / `fix:` prefixes, no Co-Authored-By trailers.
- Never commit `.env` or `*.db`.
- Every external call (RPC, Jupiter, pump.fun program ix, DexScreener, Claude) must be try-caught; a single token failure must never crash the bot.
- Add tests alongside each change — existing patterns in `tests/analyzer.test.ts` and `tests/trader.test.ts` show how to mock `@solana/web3.js` `Connection` and the spl-token helpers.
- Before considering phase 2 done, run `npm run test` (must stay green), `npx tsc --noEmit` (must be clean), and a live `SIMULATE=false npm run snipe -- --source pump` on a fresh wallet with ≤ 0.5 SOL.

### Deliberate out-of-scope (do not build)

- Automatic transaction priority-fee tuning — keep Jupiter's `prioritizationFeeLamports: 'auto'` and pick a sensible fixed fee for direct pump instructions.
- MEV protection / Jito bundles — note as a follow-up if rug-front-running becomes the dominant failure mode.
- Metadata fetching for Claude's prompt (name, symbol, image) — useful but orthogonal; current paper runs show Claude can score without it.

When you're done, update `README.md` — remove the phase-1 caveat row in the token-sources table, swap the "paper-only" note for the live-mode description, and add any new env vars to the strategy table.

---

## Notes for future-me

- The `MIN_AI_SCORE=30` experiment documented at the end of phase 1 should have told us whether Claude picks anything useful at a lower bar. If the selection was garbage, the risk-level `high` profile needs different levers (e.g., creator address heuristics) rather than just a threshold drop.
- Rough cost estimate for phase 2 engineering: a focused afternoon if the bonding-curve math is already well-documented in pump.fun's public IDL, a day if we have to reverse-engineer account layouts. Don't under-scope.
