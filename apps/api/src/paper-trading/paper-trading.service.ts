import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AIDecision, RiskEvaluation, Trade } from '@prisma/client';
import { TradeStatus } from '@prisma/client';
import { evaluate } from '@quant/risk';
import type { AccountState, RiskProfile } from '@quant/risk';
import { PrismaService } from '../common/prisma/prisma.service';

// The compile-time gate. openPosition only accepts this — approved:false is a type error at the call site.
export type ApprovedEvaluation = RiskEvaluation & { approved: true };

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Public pipeline entry point ───────────────────────────────────────────

  async executeDecision(
    userId: string,
    aiDecisionId: string,
    positionSizeUsd?: number,
  ): Promise<{ evaluation: RiskEvaluation; trade: Trade | null }> {
    const decision = await this.prisma.aIDecision.findUnique({
      where: { id: aiDecisionId },
      include: {
        strategy: { include: { riskProfile: true } },
        riskEvaluation: true,
        resultingTrade: true,
      },
    });

    if (!decision) throw new NotFoundException(`AIDecision ${aiDecisionId} not found`);
    if (decision.strategy.userId !== userId) throw new ForbiddenException();
    if (decision.signal === 'HOLD')
      throw new UnprocessableEntityException('HOLD signal cannot produce a trade');
    if (decision.riskEvaluation)
      throw new ConflictException('Decision has already been risk-evaluated');
    if (decision.resultingTrade)
      throw new ConflictException('Trade already exists for this decision');

    const size = positionSizeUsd ?? Number(decision.strategy.riskProfile.maxPositionSizeUsd);
    const evaluation = await this.runRiskEvaluation(userId, decision, size);

    if (!evaluation.approved) {
      this.logger.log({ aiDecisionId, reasons: evaluation.reasons }, 'Risk evaluation rejected');
      return { evaluation, trade: null };
    }

    // TypeScript can't narrow mutable property access, so we cast after the runtime guard above.
    const trade = await this.openPosition(userId, decision, evaluation as ApprovedEvaluation, size);
    return { evaluation, trade };
  }

  // ── Structural type gate ──────────────────────────────────────────────────

  async openPosition(
    userId: string,
    aiDecision: AIDecision,
    approvedEval: ApprovedEvaluation,
    positionSizeUsd: number,
  ): Promise<Trade> {
    // Runtime defense: belt-and-suspenders in case the type guard is bypassed (e.g. JS callers).
    if (!approvedEval.approved)
      throw new Error('openPosition called with unapproved evaluation — this is a bug');

    const latest = await this.prisma.oHLCV.findFirst({
      where: { symbolId: aiDecision.symbolId },
      orderBy: { openTime: 'desc' },
    });

    if (!latest) throw new UnprocessableEntityException('No price data for symbol');
    const entryPrice = Number(latest.close);
    const quantity = positionSizeUsd / entryPrice;
    const side = aiDecision.signal === 'BUY' ? 'LONG' : 'SHORT';

    return this.prisma.trade.create({
      data: {
        userId,
        strategyId: aiDecision.strategyId,
        aiDecisionId: aiDecision.id,
        symbolId: aiDecision.symbolId,
        side,
        entryPrice,
        quantity,
        stopLoss: aiDecision.stopLoss ?? null,
        takeProfit: aiDecision.takeProfit ?? null,
        status: TradeStatus.OPEN,
      },
    });
  }

  // ── Query endpoints ───────────────────────────────────────────────────────

  listTrades(userId: string) {
    return this.prisma.trade.findMany({
      where: { userId },
      orderBy: { openedAt: 'desc' },
      take: 100,
    });
  }

  async getTradeById(userId: string, id: string) {
    const trade = await this.prisma.trade.findUnique({ where: { id } });
    if (!trade) throw new NotFoundException(`Trade ${id} not found`);
    if (trade.userId !== userId) throw new ForbiddenException();
    return trade;
  }

  // ── Private: build AccountState + call pure evaluate() + persist ──────────

  private async runRiskEvaluation(
    userId: string,
    decision: AIDecision & {
      strategy: {
        riskProfile: {
          maxPositionSizeUsd: unknown;
          maxDailyLossUsd: unknown;
          maxDrawdownPct: unknown;
          maxOpenTrades: number;
          cooldownMinutesAfterLoss: number;
        };
      };
    },
    positionSizeUsd: number,
  ): Promise<RiskEvaluation> {
    const rp = decision.strategy.riskProfile;
    const today = startOfDay(new Date());

    const [openCount, dailyLosses, allClosed, lastLoss] = await Promise.all([
      this.prisma.trade.count({ where: { userId, status: TradeStatus.OPEN } }),
      this.prisma.trade.findMany({
        where: {
          userId,
          status: { not: TradeStatus.OPEN },
          pnl: { lt: 0 },
          closedAt: { gte: today },
        },
        select: { pnl: true },
      }),
      this.prisma.trade.findMany({
        where: { userId, status: { not: TradeStatus.OPEN } },
        orderBy: { closedAt: 'asc' },
        select: { pnl: true },
      }),
      this.prisma.trade.findFirst({
        where: { userId, pnl: { lt: 0 } },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true },
      }),
    ]);

    const dailyLossUsd = dailyLosses.reduce((sum, t) => sum + Math.abs(Number(t.pnl)), 0);

    let peak = 0;
    let equity = 0;
    for (const t of allClosed) {
      equity += Number(t.pnl);
      if (equity > peak) peak = equity;
    }
    const currentDrawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

    const accountState: AccountState = {
      openTradesCount: openCount,
      dailyLossUsd,
      currentDrawdownPct,
      lastLossAt: lastLoss?.closedAt ?? null,
    };

    const profile: RiskProfile = {
      maxPositionSizeUsd: Number(rp.maxPositionSizeUsd),
      maxDailyLossUsd: Number(rp.maxDailyLossUsd),
      maxDrawdownPct: Number(rp.maxDrawdownPct),
      maxOpenTrades: rp.maxOpenTrades,
      cooldownMinutesAfterLoss: rp.cooldownMinutesAfterLoss,
    };

    const result = evaluate({ positionSizeUsd }, accountState, profile);

    return this.prisma.riskEvaluation.create({
      data: {
        aiDecisionId: decision.id,
        approved: result.approved,
        reasons: result.reasons,
      },
    });
  }
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}
