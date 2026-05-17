import { AiScore, scoreWithModel } from './analyzer';
import { TrendingCandidate } from './trendingListener';
import { Config, loadConfig } from './config';
import { logger } from './logger';

const TRENDING_AI_SYSTEM_PROMPT = `You are a Solana memecoin trader evaluating a token that is already trending on DEX aggregators. The token has graduated to a real AMM pool — it is past the launch-lottery stage and has demonstrated traction.

Score the token 0-100 for a short-term momentum trade. Weigh:
- Name & ticker: is it memetic, sharp, the kind of name that spreads? A dull or generic name is a real negative; a great name is a real edge. This is the signal launch-time stats cannot capture.
- Liquidity & market cap: enough liquidity to enter and exit cleanly, a market cap with room to run (not already huge).
- Volume: healthy 24h volume relative to liquidity means real, active trading — not a stale pool.
- Momentum: the 1h and 6h price changes — is it climbing, stalling, or rolling over?
- Buyer/seller balance: more buyers than sellers is demand; heavy net selling is distribution.

Be decisive. Most trending tokens are mediocre — score them 30-55. Reserve 70+ for tokens with a genuinely strong name AND healthy metrics AND live momentum.

Respond ONLY with JSON:
{"score": <number 0-100>, "reasoning": "<1-2 sentence explanation citing the specific signals you weighted>"}`;

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function buildTrendingUserPrompt(c: TrendingCandidate): string {
  return `Token: ${c.name} ($${c.symbol})
DEX: ${c.dex}
Age: ${(c.ageMinutes / 60).toFixed(1)} hours
Liquidity: ${fmtUsd(c.liquidityUsd)}
Market cap: ${fmtUsd(c.marketCapUsd)}
Volume 24h: ${fmtUsd(c.volumeH24Usd)}
Volume 6h: ${fmtUsd(c.volumeH6Usd)}
Price change 1h: ${pct(c.priceChangeH1)}
Price change 6h: ${pct(c.priceChangeH6)}
Buyers 24h: ${c.buyersH24}
Sellers 24h: ${c.sellersH24}

Score this token for a momentum trade.`;
}

// Score a trending candidate 0-100 with the configured LLM, judging the name
// and the trading metrics. A failure resolves to score 0 with an error set so
// the caller skips the token without crashing the run.
export async function scoreTrendingCandidate(
  c: TrendingCandidate,
  cfg: Config = loadConfig()
): Promise<AiScore> {
  try {
    logger.debug(`${cfg.aiProvider}/${cfg.aiModel}: scoring trending ${c.symbol}`);
    const result = await scoreWithModel(
      cfg,
      TRENDING_AI_SYSTEM_PROMPT,
      buildTrendingUserPrompt(c),
      c.tokenMint
    );
    if (result.error) return result;
    logger.info(`AI scored ${c.symbol}: ${result.score}/100 — ${result.reasoning}`);
    return result;
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(`AI scoring failed for ${c.symbol}: ${message}`);
    return { score: 0, reasoning: '', error: message };
  }
}
