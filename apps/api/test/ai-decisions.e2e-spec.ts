jest.setTimeout(30_000);

import { INestApplication, UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import helmet from 'helmet';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { requestIdMiddleware } from '../src/common/middleware/request-id.middleware';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AI_PROVIDER } from '../src/ai-engine/ai-decisions.service';
import { cleanDb } from './helpers/db-clean';

// Valid signal shape the mock will return
const VALID_SIGNAL = {
  signal: 'BUY',
  confidence: 80,
  reasoning: 'Strong upward momentum',
  riskLevel: 'MEDIUM',
  stopLoss: 40000,
  takeProfit: 50000,
};

// Shape that violates the zod schema (confidence out of range, missing required fields)
const INVALID_SIGNAL = { action: 'buy', score: 999 };

const mockProvider = {
  name: 'mock',
  requestSignal: jest.fn().mockResolvedValue(VALID_SIGNAL),
};

describe('AI Decisions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<typeof app.getHttpServer>;
  let accessToken: string;
  let strategyId: string;
  let symbolId: string;

  beforeAll(async () => {
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

    app = module.createNestApplication();
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

    prisma = app.get(PrismaService);
    server = app.getHttpServer();
  });

  afterAll(() => app.close());

  beforeEach(async () => {
    await cleanDb(prisma);

    mockProvider.requestSignal.mockResolvedValue(VALID_SIGNAL);

    // Register user + get access token
    const reg = await request(server)
      .post('/api/v1/auth/register')
      .send({ email: 'ai-trader@test.com', password: 'password123' });
    accessToken = reg.body.accessToken as string;
    const userId = JSON.parse(
      Buffer.from((accessToken as string).split('.')[1], 'base64url').toString(),
    ).sub as string;

    // Seed RiskProfile + Strategy + Symbol
    const riskProfile = await prisma.riskProfile.create({
      data: {
        name: 'Conservative',
        maxPositionSizeUsd: 1000,
        maxDailyLossUsd: 200,
        maxDrawdownPct: 10,
        maxOpenTrades: 3,
        cooldownMinutesAfterLoss: 60,
      },
    });

    const strategy = await prisma.strategy.create({
      data: {
        userId,
        name: 'BTC Momentum',
        aiProvider: 'anthropic',
        symbolIds: [],
        riskProfileId: riskProfile.id,
        isActive: true,
      },
    });
    strategyId = strategy.id;

    const symbol = await prisma.symbol.create({
      data: { ticker: 'BTCUSDT', base: 'BTC', quote: 'USDT' },
    });
    symbolId = symbol.id;

    // Seed a few OHLCV rows so the service has market context
    const now = new Date();
    await prisma.oHLCV.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        symbolId: symbol.id,
        interval: '1h',
        openTime: new Date(now.getTime() - (5 - i) * 3_600_000),
        open: 42000 + i * 100,
        high: 42500 + i * 100,
        low: 41800 + i * 100,
        close: 42200 + i * 100,
        volume: 100 + i * 10,
      })),
    });
  });

  // ── POST /ai-decisions ─────────────────────────────────────────────────────

  describe('POST /api/v1/ai-decisions', () => {
    it('201: valid provider response → persisted, returned with correct shape', async () => {
      const res = await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: expect.any(String),
        strategyId,
        symbolId,
        provider: 'mock',
        signal: 'BUY',
        confidence: 80,
        reasoning: 'Strong upward momentum',
        riskLevel: 'MEDIUM',
      });
      // Verify it was actually persisted
      const saved = await prisma.aIDecision.findUnique({ where: { id: res.body.id as string } });
      expect(saved).not.toBeNull();
      expect(saved!.signal).toBe('BUY');
    });

    it('rawResponse persisted for audit trail', async () => {
      const res = await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId });

      const saved = await prisma.aIDecision.findUnique({ where: { id: res.body.id as string } });
      expect(saved!.rawResponse).toMatchObject(VALID_SIGNAL);
    });

    it('502: malformed provider response → rejected, nothing persisted', async () => {
      mockProvider.requestSignal.mockResolvedValueOnce(INVALID_SIGNAL);

      const res = await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId });

      expect(res.status).toBe(502);
      // Nothing must have been written to the DB
      const count = await prisma.aIDecision.count();
      expect(count).toBe(0);
    });

    it('502: provider throws → no DB write', async () => {
      mockProvider.requestSignal.mockRejectedValueOnce(new Error('Network timeout'));

      const res = await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId });

      expect(res.status).toBe(502);
      const count = await prisma.aIDecision.count();
      expect(count).toBe(0);
    });

    it('401 without token', async () => {
      const res = await request(server).post('/api/v1/ai-decisions').send({ strategyId, symbolId });
      expect(res.status).toBe(401);
    });

    it('404 on unknown strategy', async () => {
      const res = await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId: '00000000-0000-0000-0000-000000000000', symbolId });
      expect(res.status).toBe(404);
    });

    it('404 on unknown symbol', async () => {
      const res = await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(404);
    });

    it('422 on invalid UUID', async () => {
      const res = await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId: 'not-a-uuid', symbolId });
      expect(res.status).toBe(422);
    });
  });

  // ── GET /ai-decisions ──────────────────────────────────────────────────────

  describe('GET /api/v1/ai-decisions', () => {
    it('returns list of decisions for authenticated user', async () => {
      // Create two decisions
      await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId });
      await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId });

      const res = await request(server)
        .get('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
    });

    it('filters by strategyId when provided', async () => {
      await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId });

      const res = await request(server)
        .get(`/api/v1/ai-decisions?strategyId=${strategyId}`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].strategyId).toBe(strategyId);
    });

    it('401 without token', async () => {
      const res = await request(server).get('/api/v1/ai-decisions');
      expect(res.status).toBe(401);
    });
  });

  // ── GET /ai-decisions/:id ──────────────────────────────────────────────────

  describe('GET /api/v1/ai-decisions/:id', () => {
    it('returns a single decision by id', async () => {
      const create = await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId });

      const res = await request(server)
        .get(`/api/v1/ai-decisions/${create.body.id as string}`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(create.body.id);
      expect(res.body.signal).toBe('BUY');
    });

    it('404 on unknown id', async () => {
      const res = await request(server)
        .get('/api/v1/ai-decisions/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(404);
    });

    it('401 without token', async () => {
      const res = await request(server).get('/api/v1/ai-decisions/some-id');
      expect(res.status).toBe(401);
    });
  });

  // ── Mock provider contract ─────────────────────────────────────────────────

  describe('MockAIProvider contract', () => {
    it('called with correct symbol in context', async () => {
      await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId });

      const callArg = mockProvider.requestSignal.mock.calls[0][0] as { symbol: string };
      expect(callArg.symbol).toBe('BTCUSDT');
    });

    it('called with non-empty recentOhlcv when data exists', async () => {
      await request(server)
        .post('/api/v1/ai-decisions')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ strategyId, symbolId });

      const callArg = mockProvider.requestSignal.mock.calls[0][0] as { recentOhlcv: unknown[] };
      expect(callArg.recentOhlcv.length).toBeGreaterThan(0);
    });
  });
});
