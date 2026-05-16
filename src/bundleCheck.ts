import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';

export interface BundleCheckResult {
  // True when the launch looks bundled and the token should be vetoed.
  bundled: boolean;
  // Distinct non-creator wallets that transacted on the curve in the launch slot.
  launchSlotBuyers: number;
  reason: string;
}

// Inspects a pump.fun token's launch slot. A bundled rug submits the create
// plus a cluster of buys from its own wallets in a single Jito bundle, so
// they all land in the same slot — a manufactured initial pump that a naive
// momentum entry would buy straight into. We count the distinct buyer
// wallets (fee-payers) that touched the bonding curve in the create's slot;
// an organic launch shows only the create and maybe the dev's own buy.
//
// Fails OPEN: if the launch slot can't be reconstructed (RPC error, or the
// token is busy enough that the create has scrolled past the signature
// window), it returns bundled=false rather than vetoing on uncertainty.
export async function checkLaunchBundle(
  connection: Connection,
  createSignature: string,
  bondingCurveAddress: string,
  threshold: number
): Promise<BundleCheckResult> {
  const open = (reason: string): BundleCheckResult => ({
    bundled: false,
    launchSlotBuyers: 0,
    reason,
  });
  try {
    const createTx = await connection.getParsedTransaction(createSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!createTx) return open('create tx not found');
    const launchSlot = createTx.slot;
    const creator = createTx.transaction.message.accountKeys[0]?.pubkey?.toBase58();

    const sigs = await connection.getSignaturesForAddress(
      new PublicKey(bondingCurveAddress),
      { limit: 1000 }
    );
    const launchSlotSigs = sigs.filter(
      (s) => s.slot === launchSlot && s.signature !== createSignature && !s.err
    );
    if (launchSlotSigs.length === 0) {
      return open('no other transactions in the launch slot');
    }

    // Distinct fee-payers (≈ buyers) of the launch-slot transactions. Stop
    // reading once we have enough to veto — no point paying for more.
    const buyers = new Set<string>();
    for (const sig of launchSlotSigs) {
      const tx = await connection.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      const payer = tx?.transaction.message.accountKeys[0]?.pubkey?.toBase58();
      if (payer && payer !== creator) buyers.add(payer);
      if (threshold > 0 && buyers.size >= threshold) break;
    }

    const bundled = threshold > 0 && buyers.size >= threshold;
    return {
      bundled,
      launchSlotBuyers: buyers.size,
      reason: bundled
        ? `bundled launch — ${buyers.size} buyer wallets in the create slot`
        : `${buyers.size} launch-slot buyers (under threshold ${threshold})`,
    };
  } catch (err) {
    logger.debug(`checkLaunchBundle ${createSignature}: ${(err as Error).message}`);
    return open('bundle check failed');
  }
}
