import { nextBackoff, initialBackoff } from '../backoff';

describe('backoff', () => {
  it('initial backoff is around 1000ms', () => {
    const b = initialBackoff();
    expect(b).toBeGreaterThanOrEqual(1000);
    expect(b).toBeLessThan(1600); // 1000 + 500 jitter + small margin
  });

  it('doubles on each call', () => {
    expect(nextBackoff(1000)).toBeGreaterThanOrEqual(2000);
    expect(nextBackoff(2000)).toBeGreaterThanOrEqual(4000);
    expect(nextBackoff(4000)).toBeGreaterThanOrEqual(8000);
  });

  it('caps at 30s', () => {
    const b1 = nextBackoff(30_000);
    const b2 = nextBackoff(60_000);
    expect(b1).toBeLessThanOrEqual(30_600);
    expect(b2).toBeLessThanOrEqual(30_600);
  });
});
