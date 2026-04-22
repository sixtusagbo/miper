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
