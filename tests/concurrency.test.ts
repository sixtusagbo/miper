import { describe, expect, it, vi } from 'vitest';
import { InflightGate, TimeoutError, withTimeout } from '../src/concurrency';

describe('withTimeout', () => {
  it('resolves with the promise value when it completes in time', async () => {
    const result = await withTimeout(Promise.resolve(42), 100, 'fast');
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError when the promise takes too long', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 100));
    await expect(withTimeout(slow, 20, 'slow op')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('propagates rejections from the inner promise', async () => {
    const bad = Promise.reject(new Error('boom'));
    await expect(withTimeout(bad, 100, 'x')).rejects.toThrow(/boom/);
  });

  it('clears the timer when the promise resolves (no hanging timeout)', async () => {
    vi.useFakeTimers();
    try {
      const result = withTimeout(Promise.resolve('ok'), 1000, 'x');
      await expect(result).resolves.toBe('ok');
      // Advancing past the timeout should NOT reject anything — timer was cleared.
      vi.advanceTimersByTime(2000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InflightGate', () => {
  it('allows acquisitions up to the capacity', () => {
    const gate = new InflightGate(2);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.inflight).toBe(2);
    expect(gate.tryAcquire()).toBe(false);
  });

  it('release opens a slot for new callers', () => {
    const gate = new InflightGate(1);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    gate.release();
    expect(gate.tryAcquire()).toBe(true);
  });

  it('release cannot drive the counter negative', () => {
    const gate = new InflightGate(1);
    gate.release();
    gate.release();
    expect(gate.inflight).toBe(0);
    expect(gate.tryAcquire()).toBe(true);
  });
});
