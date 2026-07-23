import type { AIProvider } from './provider';
import type { AISignalRequest } from './types';

const SIGNALS = ['BUY', 'SELL', 'HOLD'] as const;

/** Deterministic, no-network provider for tests and offline demos. */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  private tick = 0;

  requestSignal(ctx: AISignalRequest): Promise<unknown> {
    const signal = SIGNALS[this.tick++ % 3];
    return Promise.resolve({
      signal,
      confidence: 75,
      reasoning: `Mock signal for ${ctx.symbol}: deterministic cycle`,
      riskLevel: 'LOW',
      stopLoss: null,
      takeProfit: null,
    });
  }
}
