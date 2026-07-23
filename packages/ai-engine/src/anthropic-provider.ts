import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from './provider';
import type { AISignalRequest } from './types';

const MODEL = 'claude-sonnet-5';

const EMIT_SIGNAL_TOOL: Anthropic.Tool = {
  name: 'emit_signal',
  description: 'Emit a structured trading signal based on the supplied market context.',
  input_schema: {
    type: 'object',
    properties: {
      signal: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'], description: 'Trading direction' },
      confidence: { type: 'integer', minimum: 0, maximum: 100, description: 'Confidence 0–100' },
      reasoning: { type: 'string', description: 'Brief reasoning for the signal' },
      riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: 'Assessed risk' },
      stopLoss: { type: 'number', description: 'Stop-loss price, or null' },
      takeProfit: { type: 'number', description: 'Take-profit price, or null' },
    },
    required: ['signal', 'confidence', 'reasoning', 'riskLevel'],
  },
};

export class AnthropicAIProvider implements AIProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async requestSignal(ctx: AISignalRequest): Promise<unknown> {
    const ohlcvLines = ctx.recentOhlcv
      .slice(-20)
      .map((b) => `${b.openTime} O:${b.open} H:${b.high} L:${b.low} C:${b.close} V:${b.volume}`)
      .join('\n');

    const userContent = [
      `Symbol: ${ctx.symbol}`,
      ctx.currentPrice != null ? `Current price: ${ctx.currentPrice}` : null,
      ctx.recentOhlcv.length
        ? `Recent OHLCV (${ctx.recentOhlcv[0].interval}):\n${ohlcvLines}`
        : 'No OHLCV history available.',
    ]
      .filter(Boolean)
      .join('\n');

    const msg = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: [EMIT_SIGNAL_TOOL],
      tool_choice: { type: 'tool', name: 'emit_signal' },
      messages: [{ role: 'user', content: userContent }],
    });

    const toolBlock = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!toolBlock) throw new Error('Anthropic returned no tool_use block');

    return toolBlock.input;
  }
}
