export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(t);
        resolve(value);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}

// Retries an async operation with linear backoff. Intended for reads that
// race with chain propagation — a fresh mint often isn't visible to every
// RPC node for a few hundred ms after creation, so a single attempt
// misclassifies real tokens as dead.
export async function retry<T>(
  fn: () => Promise<T>,
  options: { attempts: number; baseDelayMs: number; label?: string } = {
    attempts: 3,
    baseDelayMs: 300,
  }
): Promise<T> {
  const { attempts, baseDelayMs, label } = options;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  if (label) {
    (lastErr as Error).message = `${label}: ${(lastErr as Error).message || 'unknown error'}`;
  }
  throw lastErr;
}

// Simple in-flight counter used to cap how many analyses / fetches run in
// parallel. Not a fair queue: callers decide to proceed or skip. This is
// intentional for a sniping bot where a stale pool is worth less than a fresh
// one, so dropping work under load beats queueing it forever.
export class InflightGate {
  private count = 0;
  constructor(private readonly max: number) {}

  get inflight(): number {
    return this.count;
  }

  get capacity(): number {
    return this.max;
  }

  tryAcquire(): boolean {
    if (this.count >= this.max) return false;
    this.count++;
    return true;
  }

  release(): void {
    if (this.count > 0) this.count--;
  }
}
