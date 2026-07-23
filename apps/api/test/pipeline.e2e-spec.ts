jest.setTimeout(30_000);

import { INestApplication, UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import helmet from 'helmet';
import request from 'supertest';
import { TradeStatus } from '@prisma/client';
import type { RiskEvaluation } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { requestIdMiddleware } from '../src/common/middleware/request-id.middleware';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AI_PROVIDER } from '../src/ai-engine/ai-decisions.service';
import { PaperTradingService } from '../src/paper-trading/paper-trading.service';
import { cleanDb } from './helpers/db-clean';

const VALID_SIGNAL = {
  signal: 'BUY',
  confidence: 75,
  reasoning: 'Momentum breakout',
  riskLevel: 'MEDIUM',
  stopLoss: 40000,
  takeProfit: 50000,
};

const mockProvider = {
  name: 'mock',
  requestSignal: jest.fn().mockResolvedValue(VALID_SIGNAL),
};

// ── Test doubles ─────────────────────────────────────────────────────────────

async function setup() {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ThrottlerStorage)
    .useValue({
      increment: async () => ({
        totalHits: 1,
        timeToExpire: 60_000,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    })
    .overrideProvider(AI_PROVIDER)
    .useValue(mockProvider)
    .compile();

  const app = module.createNestApplication();
  app.use(helmet());
  app.use(requestIdMiddleware);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        new UnprocessableEntityException(
          errors.flatMap((e) => Object.values(e.constraints ?? {})).join('; '),
        ),
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

type Fixture = {
  userId: string;
  accessToken: string;
  strategyId: string;
  symbolId: string;
  riskProfileId: string;
};

async function seed(
  prisma: PrismaService,
  server: ReturnType<typeof request>,
  riskProfileOverrides: Record<string, unknown> = {},
): Promise<Fixture> {
  const reg = await request(server as unknown as import('http').Server)
    .post('/api/v1/auth/register')
    .send({ email: `trader-${Date.now()}@test.com`, password: 'password123' });
  const accessToken = reg.body.accessToken as string;
  const userId = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString())
    .sub as string;

  const riskProfile = await prisma.riskProfile.create({
    data: {
      name: 'Test Profile',
      maxPositionSizeUsd: 10_000,
      maxDailyLossUsd: 500,
      maxDrawdownPct: 20,
      maxOpenTrades: 5,
      cooldownMinutesAfterLoss: 60,
      ...riskProfileOverrides,
    },
  });

  const strategy = await prisma.strategy.create({
    data: {
      userId,
      name: 'Test Strategy',
      aiProvider: 'mock',
      symbolIds: [],
      riskProfileId: riskProfile.id,
      isActive: true,
    },
  });

  const symbol = await prisma.symbol.create({
    data: { ticker: 'BTCUSDT', base: 'BTC', quote: 'USDT' },
  });

  const now = new Date();
  await prisma.oHLCV.createMany({
    data: Array.from({ length: 5 }, (_, i) => ({
      symbolId: symbol.id,
      interval: '1h',
      openTime: new Date(now.getTime() - (5 - i) * 3_600_000),
      open: 45000 + i * 100,
      high: 45500 + i * 100,
      low: 44800 + i * 100,
      close: 45200 + i * 100,
      volume: 100 + i * 10,
    })),
  });

  return {
    userId,
    accessToken,
    strategyId: strategy.id,
    symbolId: symbol.id,
    riskProfileId: riskProfile.id,
  };
}

async function createDecision(
  server: ReturnType<typeof request>,
  accessToken: string,
  strategyId: string,
  symbolId: string,
  signal: string = 'BUY',
): Promise<string> {
  mockProvider.requestSignal.mockResolvedValueOnce({ ...VALID_SIGNAL, signal });
  const res = await request(server as unknown as import('http').Server)
    .post('/api/v1/ai-decisions')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ strategyId, symbolId });
  return res.body.id as string;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Risk + PaperTrading pipeline (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let paperTradingService: PaperTradingService;
  let server: ReturnType<typeof app.getHttpServer>;

  beforeAll(async () => {
    app = await setup();
    prisma = app.get(PrismaService);
    paperTradingService = app.get(PaperTradingService);
    server = app.getHttpServer();
  });

  afterAll(() => app.close());

  beforeEach(async () => {
    await cleanDb(prisma);
    mockProvider.requestSignal.mockResolvedValue(VALID_SIGNAL);
  });

  // ── Full approved pipeline ─────────────────────────────────────────────────

  describe('approved pipeline', () => {
    it('creates RiskEvaluation + Trade when all rules pass', async () => {
      const { accessToken, strategyId, symbolId, userId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
      );
      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
      );

      const res = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.evaluation.approved).toBe(true);
      expect(res.body.evaluation.reasons).toHaveLength(0);
      expect(res.body.trade).not.toBeNull();
      expect(res.body.trade.status).toBe('OPEN');
      expect(res.body.trade.side).toBe('LONG');
      expect(res.body.trade.userId).toBe(userId);

      // Verify DB state
      const [evalCount, tradeCount] = await Promise.all([
        prisma.riskEvaluation.count(),
        prisma.trade.count(),
      ]);
      expect(evalCount).toBe(1);
      expect(tradeCount).toBe(1);
    });

    it('SELL signal produces SHORT trade', async () => {
      const { accessToken, strategyId, symbolId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
      );
      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
        'SELL',
      );

      const res = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.trade.side).toBe('SHORT');
    });

    it('GET /trades lists the created trade', async () => {
      const { accessToken, strategyId, symbolId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
      );
      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
      );
      await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      const res = await request(server)
        .get('/api/v1/trades')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
    });

    it('GET /trades/:id returns the trade', async () => {
      const { accessToken, strategyId, symbolId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
      );
      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
      );
      const execRes = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      const tradeId = execRes.body.trade.id as string;
      const res = await request(server)
        .get(`/api/v1/trades/${tradeId}`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(tradeId);
    });
  });

  // ── Risk rule: position size ───────────────────────────────────────────────

  describe('rule: max position size', () => {
    it('rejects when positionSizeUsd exceeds maxPositionSizeUsd', async () => {
      const { accessToken, strategyId, symbolId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
        { maxPositionSizeUsd: 100 },
      );
      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
      );

      const res = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ positionSizeUsd: 5000 });

      expect(res.status).toBe(200);
      expect(res.body.evaluation.approved).toBe(false);
      expect(res.body.evaluation.reasons[0]).toMatch(/position size/i);
      expect(res.body.trade).toBeNull();

      expect(await prisma.trade.count()).toBe(0);
    });
  });

  // ── Risk rule: daily loss ──────────────────────────────────────────────────

  describe('rule: max daily loss', () => {
    it('rejects when daily loss is at or above limit', async () => {
      const { accessToken, strategyId, symbolId, userId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
        { maxDailyLossUsd: 100 },
      );

      // Seed a losing trade closed today
      await prisma.trade.create({
        data: {
          userId,
          strategyId,
          symbolId,
          side: 'LONG',
          entryPrice: 45000,
          quantity: 0.01,
          status: TradeStatus.CLOSED,
          pnl: -200,
          closedAt: new Date(),
        },
      });

      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
      );

      const res = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.evaluation.approved).toBe(false);
      expect(res.body.evaluation.reasons[0]).toMatch(/daily loss/i);
      expect(res.body.trade).toBeNull();
    });
  });

  // ── Risk rule: max drawdown ────────────────────────────────────────────────

  describe('rule: max drawdown', () => {
    it('rejects when drawdown from equity peak exceeds limit', async () => {
      const { accessToken, strategyId, symbolId, userId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
        { maxDrawdownPct: 10 },
      );

      // Build a trade history: +$500 peak, then -$200 loss = 40% drawdown
      const yesterday = new Date(Date.now() - 86_400_000);
      await prisma.trade.createMany({
        data: [
          {
            userId,
            strategyId,
            symbolId,
            side: 'LONG',
            entryPrice: 45000,
            quantity: 0.01,
            status: TradeStatus.CLOSED,
            pnl: 500,
            closedAt: new Date(yesterday.getTime() - 3_600_000),
          },
          {
            userId,
            strategyId,
            symbolId,
            side: 'LONG',
            entryPrice: 45000,
            quantity: 0.01,
            status: TradeStatus.CLOSED,
            pnl: -200,
            closedAt: yesterday,
          },
        ],
      });

      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
      );

      const res = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.evaluation.approved).toBe(false);
      expect(res.body.evaluation.reasons[0]).toMatch(/drawdown/i);
      expect(res.body.trade).toBeNull();
    });
  });

  // ── Risk rule: max open trades ─────────────────────────────────────────────

  describe('rule: max open trades', () => {
    it('rejects when open trades count is at limit', async () => {
      const { accessToken, strategyId, symbolId, userId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
        { maxOpenTrades: 2 },
      );

      // Seed 2 open trades (at limit)
      await prisma.trade.createMany({
        data: Array.from({ length: 2 }, () => ({
          userId,
          strategyId,
          symbolId,
          side: 'LONG',
          entryPrice: 45000,
          quantity: 0.01,
          status: TradeStatus.OPEN,
        })),
      });

      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
      );

      const res = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.evaluation.approved).toBe(false);
      expect(res.body.evaluation.reasons[0]).toMatch(/open trades/i);
      expect(res.body.trade).toBeNull();
    });
  });

  // ── Risk rule: cooldown after loss ─────────────────────────────────────────

  describe('rule: cooldown after loss', () => {
    it('rejects when last loss is within cooldown window', async () => {
      const { accessToken, strategyId, symbolId, userId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
        { cooldownMinutesAfterLoss: 120 },
      );

      // Loss 10 minutes ago — within the 120-minute cooldown
      await prisma.trade.create({
        data: {
          userId,
          strategyId,
          symbolId,
          side: 'LONG',
          entryPrice: 45000,
          quantity: 0.01,
          status: TradeStatus.CLOSED,
          pnl: -50,
          closedAt: new Date(Date.now() - 10 * 60_000),
        },
      });

      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
      );

      const res = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.evaluation.approved).toBe(false);
      expect(res.body.evaluation.reasons[0]).toMatch(/cooldown/i);
      expect(res.body.trade).toBeNull();
    });

    it('approves when last loss is outside the cooldown window', async () => {
      const { accessToken, strategyId, symbolId, userId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
        { cooldownMinutesAfterLoss: 5 },
      );

      // Loss 10 minutes ago — outside the 5-minute cooldown
      await prisma.trade.create({
        data: {
          userId,
          strategyId,
          symbolId,
          side: 'LONG',
          entryPrice: 45000,
          quantity: 0.01,
          status: TradeStatus.CLOSED,
          pnl: -50,
          closedAt: new Date(Date.now() - 10 * 60_000),
        },
      });

      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
      );

      const res = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.evaluation.approved).toBe(true);
      expect(res.body.trade).not.toBeNull();
    });
  });

  // ── Structural type constraint ─────────────────────────────────────────────

  describe('openPosition type constraint', () => {
    it('compile-time: openPosition rejects RiskEvaluation with approved:false', async () => {
      const { userId, strategyId, symbolId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
      );

      const decision = await prisma.aIDecision.create({
        data: {
          strategyId,
          symbolId,
          provider: 'mock',
          signal: 'BUY',
          confidence: 80,
          reasoning: 'test',
          riskLevel: 'LOW',
          rawResponse: {},
        },
      });

      const rejectedEval: RiskEvaluation = await prisma.riskEvaluation.create({
        data: { aiDecisionId: decision.id, approved: false, reasons: ['test rejection'] },
      });

      // This line must be a TypeScript compile error — @ts-expect-error verifies the type guard.
      // If openPosition's parameter type is loosened to accept boolean, this test file will fail
      // to compile (unused @ts-expect-error becomes an error).
      // @ts-expect-error: openPosition only accepts ApprovedEvaluation (approved: true), not RiskEvaluation
      await expect(
        paperTradingService.openPosition(userId, decision, rejectedEval, 1000),
      ).rejects.toBeDefined();
    });

    it('runtime: openPosition accepts narrowed ApprovedEvaluation', async () => {
      const { userId, strategyId, symbolId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
      );

      const decision = await prisma.aIDecision.create({
        data: {
          strategyId,
          symbolId,
          provider: 'mock',
          signal: 'BUY',
          confidence: 80,
          reasoning: 'test',
          riskLevel: 'LOW',
          rawResponse: {},
        },
      });

      // Manually create an approved evaluation (approved: true narrows the type)
      const approvedEval = await prisma.riskEvaluation.create({
        data: { aiDecisionId: decision.id, approved: true, reasons: [] },
      });

      // After the if-check, TypeScript narrows approvedEval to ApprovedEvaluation
      if (!approvedEval.approved) throw new Error('unreachable');
      const trade = await paperTradingService.openPosition(userId, decision, approvedEval, 1000);

      expect(trade.userId).toBe(userId);
      expect(trade.status).toBe('OPEN');
    });
  });

  // ── Idempotency & guards ───────────────────────────────────────────────────

  describe('execute guards', () => {
    it('409 on double execute', async () => {
      const { accessToken, strategyId, symbolId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
      );
      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
      );

      await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      const res = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(409);
    });

    it('422 on HOLD signal', async () => {
      const { accessToken, strategyId, symbolId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
      );
      const decisionId = await createDecision(
        server as unknown as ReturnType<typeof request>,
        accessToken,
        strategyId,
        symbolId,
        'HOLD',
      );

      const res = await request(server)
        .post(`/api/v1/ai-decisions/${decisionId}/execute`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(422);
      expect(await prisma.trade.count()).toBe(0);
    });

    it('404 on unknown decision', async () => {
      const { accessToken } = await seed(prisma, server as unknown as ReturnType<typeof request>);

      const res = await request(server)
        .post('/api/v1/ai-decisions/00000000-0000-0000-0000-000000000000/execute')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(404);
    });

    it('401 without token', async () => {
      const res = await request(server)
        .post('/api/v1/ai-decisions/00000000-0000-0000-0000-000000000000/execute')
        .send({});
      expect(res.status).toBe(401);
    });
  });

  // ── Risk profiles CRUD ─────────────────────────────────────────────────────

  describe('POST /api/v1/risk-profiles', () => {
    it('creates a risk profile', async () => {
      const { accessToken } = await seed(prisma, server as unknown as ReturnType<typeof request>);

      const res = await request(server)
        .post('/api/v1/risk-profiles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: 'Aggressive',
          maxPositionSizeUsd: 50000,
          maxDailyLossUsd: 5000,
          maxDrawdownPct: 30,
          maxOpenTrades: 10,
          cooldownMinutesAfterLoss: 15,
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Aggressive');
      expect(res.body.id).toBeDefined();
    });

    it('422 on invalid payload', async () => {
      const { accessToken } = await seed(prisma, server as unknown as ReturnType<typeof request>);

      const res = await request(server)
        .post('/api/v1/risk-profiles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Bad', maxPositionSizeUsd: -100 });

      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/v1/risk-profiles', () => {
    it('lists risk profiles', async () => {
      const { accessToken } = await seed(prisma, server as unknown as ReturnType<typeof request>);

      const res = await request(server)
        .get('/api/v1/risk-profiles')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });

  describe('PATCH /api/v1/risk-profiles/:id', () => {
    it('updates a risk profile field', async () => {
      const { accessToken, riskProfileId } = await seed(
        prisma,
        server as unknown as ReturnType<typeof request>,
      );

      const res = await request(server)
        .patch(`/api/v1/risk-profiles/${riskProfileId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ maxOpenTrades: 10 });

      expect(res.status).toBe(200);
      expect(res.body.maxOpenTrades).toBe(10);
    });
  });
});
