import OpenAI from 'openai';
import type { AIProvider } from './provider';
import type { AISignalRequest } from './types';

const MODEL = 'llama-3.3-70b-versatile';

const EMIT_SIGNAL_TOOL: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'emit_signal',
    description: 'Emit a structured trading signal based on the supplied market context.',
    parameters: {
      type: 'object',
      properties: {
        signal: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'], description: 'Trading direction' },
        confidence: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Confidence 0–100',
        },
        reasoning: { type: 'string', description: 'Brief reasoning for the signal' },
        riskLevel: {
          type: 'string',
          enum: ['LOW', 'MEDIUM', 'HIGH'],
          description: 'Assessed risk level',
        },
        stopLoss: { type: 'number', description: 'Stop-loss price, or omit if none' },
        takeProfit: { type: 'number', description: 'Take-profit price, or omit if none' },
      },
      required: ['signal', 'confidence', 'reasoning', 'riskLevel'],
    },
  },
};

export class GroqAIProvider implements AIProvider {
  readonly name = 'groq';
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
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

    const response = await this.client.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      tools: [EMIT_SIGNAL_TOOL],
      tool_choice: { type: 'function', function: { name: 'emit_signal' } },
      messages: [{ role: 'user', content: userContent }],
    });

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') {
      throw new Error('Groq returned no tool call');
    }

    return JSON.parse(toolCall.function.arguments) as unknown;
  }
}
