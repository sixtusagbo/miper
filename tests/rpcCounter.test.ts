import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatRpcCounts,
  getRpcCounts,
  instrumentConnection,
  resetRpcCounts,
} from '../src/rpcCounter';

beforeEach(() => {
  resetRpcCounts();
});
afterEach(() => {
  resetRpcCounts();
});

function makeFakeConn() {
  return {
    rpcEndpoint: 'https://example/rpc',
    getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(0) }),
    getParsedTransaction: vi.fn().mockResolvedValue(null),
    getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    onLogs: vi.fn().mockReturnValue(1),
  } as any;
}

describe('instrumentConnection', () => {
  it('counts each method call by name', async () => {
    const conn = instrumentConnection(makeFakeConn());
    await conn.getAccountInfo('A' as any);
    await conn.getAccountInfo('B' as any);
    await conn.getParsedTransaction('sig');
    expect(getRpcCounts()).toEqual({
      getAccountInfo: 2,
      getParsedTransaction: 1,
    });
  });

  it('forwards arguments and the underlying return value', async () => {
    const raw = makeFakeConn();
    raw.getSignaturesForAddress = vi.fn().mockResolvedValue([{ signature: 's' }]);
    const conn = instrumentConnection(raw);
    const result = await conn.getSignaturesForAddress('pk' as any, { limit: 10 });
    expect(result).toEqual([{ signature: 's' }]);
    expect(raw.getSignaturesForAddress).toHaveBeenCalledWith('pk', { limit: 10 });
  });

  it('does not count plain property reads', () => {
    const conn = instrumentConnection(makeFakeConn());
    void conn.rpcEndpoint;
    expect(getRpcCounts()).toEqual({});
  });
});

describe('formatRpcCounts', () => {
  it('reports 0 calls cleanly for an empty snapshot', () => {
    expect(formatRpcCounts({})).toBe('rpc: 0 calls');
  });

  it('sorts methods by descending count', () => {
    const out = formatRpcCounts({
      getAccountInfo: 100,
      getParsedTransaction: 5,
      getSignaturesForAddress: 30,
    });
    expect(out).toContain('rpc: 135 calls');
    expect(out.indexOf('getAccountInfo=100')).toBeLessThan(
      out.indexOf('getSignaturesForAddress=30')
    );
    expect(out.indexOf('getSignaturesForAddress=30')).toBeLessThan(
      out.indexOf('getParsedTransaction=5')
    );
  });
});
