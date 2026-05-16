import { describe, expect, it, vi } from 'vitest';
import { checkLaunchBundle } from '../src/bundleCheck';

const CURVE = 'So11111111111111111111111111111111111111112';
const CREATE_SIG = 'create-sig';
const LAUNCH_SLOT = 1000;

// A parsed-transaction stub with a given fee-payer at accountKeys[0].
function txStub(feePayer: string, slot: number) {
  return {
    slot,
    transaction: {
      message: { accountKeys: [{ pubkey: { toBase58: () => feePayer } }] },
    },
  };
}

function fakeConnection(opts: {
  creator?: string;
  sigs: { signature: string; slot: number; err?: unknown }[];
  payers: Record<string, string>;
}) {
  return {
    getParsedTransaction: vi.fn(async (sig: string) => {
      if (sig === CREATE_SIG) return txStub(opts.creator ?? 'CREATOR', LAUNCH_SLOT);
      const payer = opts.payers[sig];
      return payer ? txStub(payer, LAUNCH_SLOT) : null;
    }),
    getSignaturesForAddress: vi.fn(async () => opts.sigs),
  } as never;
}

describe('checkLaunchBundle', () => {
  it('flags a bundled launch — distinct buyers cluster in the create slot', async () => {
    const conn = fakeConnection({
      sigs: [
        { signature: 'b1', slot: LAUNCH_SLOT },
        { signature: 'b2', slot: LAUNCH_SLOT },
        { signature: 'b3', slot: LAUNCH_SLOT },
        { signature: 'later', slot: LAUNCH_SLOT + 5 },
      ],
      payers: { b1: 'W1', b2: 'W2', b3: 'W3', later: 'W4' },
    });
    const r = await checkLaunchBundle(conn, CREATE_SIG, CURVE, 3);
    expect(r.bundled).toBe(true);
    expect(r.launchSlotBuyers).toBe(3);
  });

  it('passes an organic launch — only one buyer in the create slot', async () => {
    const conn = fakeConnection({
      sigs: [
        { signature: 'b1', slot: LAUNCH_SLOT },
        { signature: 'later', slot: LAUNCH_SLOT + 9 },
      ],
      payers: { b1: 'W1', later: 'W2' },
    });
    const r = await checkLaunchBundle(conn, CREATE_SIG, CURVE, 3);
    expect(r.bundled).toBe(false);
    expect(r.launchSlotBuyers).toBe(1);
  });

  it('excludes the creator wallet from the launch-slot buyer count', async () => {
    const conn = fakeConnection({
      creator: 'DEV',
      sigs: [
        { signature: 'devbuy', slot: LAUNCH_SLOT },
        { signature: 'b1', slot: LAUNCH_SLOT },
      ],
      payers: { devbuy: 'DEV', b1: 'W1' },
    });
    const r = await checkLaunchBundle(conn, CREATE_SIG, CURVE, 3);
    expect(r.launchSlotBuyers).toBe(1); // the dev's own buy is not counted
    expect(r.bundled).toBe(false);
  });

  it('fails open when the create tx cannot be found', async () => {
    const conn = {
      getParsedTransaction: vi.fn().mockResolvedValue(null),
      getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    } as never;
    const r = await checkLaunchBundle(conn, CREATE_SIG, CURVE, 3);
    expect(r.bundled).toBe(false);
  });

  it('fails open on an RPC error', async () => {
    const conn = {
      getParsedTransaction: vi.fn().mockRejectedValue(new Error('rpc down')),
      getSignaturesForAddress: vi.fn(),
    } as never;
    const r = await checkLaunchBundle(conn, CREATE_SIG, CURVE, 3);
    expect(r.bundled).toBe(false);
  });
});
