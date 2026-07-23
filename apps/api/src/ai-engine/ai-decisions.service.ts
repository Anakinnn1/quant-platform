import {
  BadGatewayException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AISignalSchema, type AIProvider } from '@quant/ai-engine';
import { PrismaService } from '../common/prisma/prisma.service';

export const AI_PROVIDER = 'AI_PROVIDER';

@Injectable()
export class AIDecisionsService {
  private readonly logger = new Logger(AIDecisionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_PROVIDER) private readonly provider: AIProvider,
  ) {}

  async requestSignal(userId: string, strategyId: string, symbolId: string) {
    const [strategy, symbol] = await Promise.all([
      this.prisma.strategy.findUnique({ where: { id: strategyId } }),
      this.prisma.symbol.findUnique({ where: { id: symbolId } }),
    ]);
    if (!strategy) throw new NotFoundException(`Strategy ${strategyId} not found`);
    if (strategy.userId !== userId) throw new ForbiddenException();
    if (!symbol) throw new NotFoundException(`Symbol ${symbolId} not found`);

    const recentOhlcv = await this.prisma.oHLCV.findMany({
      where: { symbolId },
      orderBy: { openTime: 'desc' },
      take: 50,
    });

    const currentPrice =
      recentOhlcv.length > 0 ? parseFloat(recentOhlcv[0].close.toString()) : undefined;

    const ctx = {
      symbol: symbol.ticker,
      currentPrice,
      recentOhlcv: recentOhlcv.reverse().map((r) => ({
        openTime: r.openTime.toISOString(),
        open: r.open.toString(),
        high: r.high.toString(),
        low: r.low.toString(),
        close: r.close.toString(),
        volume: r.volume.toString(),
        interval: r.interval,
      })),
      strategyName: strategy.name,
    };

    let rawResponse: unknown;
    try {
      rawResponse = await this.provider.requestSignal(ctx);
    } catch (err) {
      this.logger.error({ err }, 'AI provider call failed');
      throw new BadGatewayException('AI provider call failed');
    }

    const result = AISignalSchema.safeParse(rawResponse);
    if (!result.success) {
      this.logger.error(
        { issues: result.error.issues, rawResponse },
        'AI provider returned invalid shape — discarded, not persisted',
      );
      throw new BadGatewayException('Provider returned invalid signal shape');
    }

    const parsed = result.data;
    return this.prisma.aIDecision.create({
      data: {
        strategyId,
        symbolId,
        provider: this.provider.name,
        signal: parsed.signal,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        riskLevel: parsed.riskLevel,
        stopLoss: parsed.stopLoss ?? null,
        takeProfit: parsed.takeProfit ?? null,
        rawResponse: rawResponse as object,
      },
    });
  }

  list(userId: string, strategyId?: string) {
    return this.prisma.aIDecision.findMany({
      where: {
        strategy: { userId },
        ...(strategyId ? { strategyId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getById(userId: string, id: string) {
    const decision = await this.prisma.aIDecision.findUnique({
      where: { id },
      include: { strategy: { select: { userId: true } } },
    });
    if (!decision) throw new NotFoundException(`AIDecision ${id} not found`);
    if (decision.strategy.userId !== userId) throw new ForbiddenException();
    return decision;
  }
}
