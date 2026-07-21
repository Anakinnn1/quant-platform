const INITIAL_MS = 1_000;
const MAX_MS = 30_000;
const JITTER_RANGE = 500;

/**
 * Returns the next backoff delay in ms, doubling each call up to MAX_MS,
 * with up to JITTER_RANGE ms of random jitter to spread reconnect storms.
 */
export function nextBackoff(currentMs: number): number {
  const next = Math.min(currentMs * 2, MAX_MS);
  return next + Math.random() * JITTER_RANGE;
}

export function initialBackoff(): number {
  return INITIAL_MS + Math.random() * JITTER_RANGE;
}
