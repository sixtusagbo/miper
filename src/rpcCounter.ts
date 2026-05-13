import type { Connection } from '@solana/web3.js';

// Cumulative per-method call counts for the wrapped Connection in this
// process. Helius bills per RPC method (1 credit each for the calls we
// make), so this is a direct local mirror of credit consumption — useful
// when the dashboard's billing endpoint is gated behind a paid plan.
const counts: Record<string, number> = Object.create(null);

const SKIPPED_PROPS = new Set([
  'rpcEndpoint',
  'commitment',
  '_rpcEndpoint',
  '_rpcWebSocket',
  '_rpcWsEndpoint',
]);

// Wraps a Connection in a Proxy that increments counts[methodName] for
// every method invocation. Returns the proxy; callers should use it
// everywhere they would have used the raw Connection.
export function instrumentConnection(conn: Connection): Connection {
  return new Proxy(conn, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string') return (value as Function).bind(target);
      if (SKIPPED_PROPS.has(prop) || prop.startsWith('_')) {
        return (value as Function).bind(target);
      }
      return (...args: unknown[]) => {
        counts[prop] = (counts[prop] ?? 0) + 1;
        return (value as Function).apply(target, args);
      };
    },
  }) as Connection;
}

export function getRpcCounts(): Readonly<Record<string, number>> {
  return { ...counts };
}

export function resetRpcCounts(): void {
  for (const k of Object.keys(counts)) delete counts[k];
}

export function formatRpcCounts(snapshot: Record<string, number>): string {
  const total = Object.values(snapshot).reduce((a, b) => a + b, 0);
  if (total === 0) return 'rpc: 0 calls';
  const sorted = Object.entries(snapshot).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 6).map(([k, v]) => `${k}=${v}`).join(' ');
  return `rpc: ${total} calls | ${top}`;
}
