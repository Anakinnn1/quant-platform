import { z } from 'zod';

export const AISignalSchema = z.object({
  signal: z.enum(['BUY', 'SELL', 'HOLD']),
  confidence: z.number().int().min(0).max(100),
  reasoning: z.string().min(1),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  stopLoss: z.number().nullable().optional(),
  takeProfit: z.number().nullable().optional(),
});

export type AISignalResponse = z.infer<typeof AISignalSchema>;
