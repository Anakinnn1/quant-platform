import { INestApplication, UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import helmet from 'helmet';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { requestIdMiddleware } from '../src/common/middleware/request-id.middleware';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { BINANCE_CLIENT } from '../src/exchange/exchange.service';

describe('MarketData (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<typeof app.getHttpServer>;
  let symbolId: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({ increment: async () => ({ totalHits: 1, timeToExpire: 60_000, isBlocked: false, timeToBlockExpire: 0 }) })
      .overrideProvider(BINANCE_CLIENT)
      .useValue({ getAccountBalance: jest.fn(), getKlines: jest.fn().mockResolvedValue([]) })
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

    // Seed a test symbol and OHLCV data.
    const symbol = await prisma.symbol.upsert({
      where: { ticker: 'TESTUSDT' },
      create: { ticker: 'TESTUSDT', base: 'TEST', quote: 'USDT' },
      update: {},
    });
    symbolId = symbol.id;

    const base = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await prisma.oHLCV.upsert({
        where: {
          symbolId_interval_openTime: {
            symbolId: symbol.id,
            interval: '1m',
            openTime: new Date(base.getTime() + i * 60_000),
          },
        },
        create: {
          symbolId: symbol.id,
          interval: '1m',
          openTime: new Date(base.getTime() + i * 60_000),
          open: '100',
          high: '110',
          low: '90',
          close: String(100 + i),
          volume: '1000',
        },
        update: {},
      });
    }
  });

  afterAll(async () => {
    await prisma.oHLCV.deleteMany({ where: { symbolId } });
    await prisma.symbol.deleteMany({ where: { ticker: 'TESTUSDT' } });
    await app.close();
  });

  // ── GET /market-data/symbols ───────────────────────────────────────────────

  describe('GET /api/v1/market-data/symbols', () => {
    it('returns active symbols including seeded test symbol', async () => {
      const res = await request(server).get('/api/v1/market-data/symbols');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const found = (res.body as Array<{ ticker: string }>).find((s) => s.ticker === 'TESTUSDT');
      expect(found).toBeDefined();
      expect(found!.ticker).toBe('TESTUSDT');
    });
  });

  // ── GET /market-data/ohlcv ────────────────────────────────────────────────

  describe('GET /api/v1/market-data/ohlcv', () => {
    it('returns candles for a symbol', async () => {
      const res = await request(server)
        .get('/api/v1/market-data/ohlcv')
        .query({ symbol: 'TESTUSDT', interval: '1m' });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(5);
      expect(res.body.nextCursor).toBeNull();
    });

    it('paginates with limit and cursor', async () => {
      const page1 = await request(server)
        .get('/api/v1/market-data/ohlcv')
        .query({ symbol: 'TESTUSDT', interval: '1m', limit: 2 });

      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.nextCursor).not.toBeNull();

      const page2 = await request(server)
        .get('/api/v1/market-data/ohlcv')
        .query({ symbol: 'TESTUSDT', interval: '1m', limit: 2, cursor: page1.body.nextCursor as string });

      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(2);
      // All items on page 2 must be after the cursor
      const cursorTime = new Date(page1.body.nextCursor as string).getTime();
      for (const row of page2.body.data as Array<{ openTime: string }>) {
        expect(new Date(row.openTime).getTime()).toBeGreaterThan(cursorTime);
      }
    });

    it('filters by from/to date range', async () => {
      const res = await request(server)
        .get('/api/v1/market-data/ohlcv')
        .query({
          symbol: 'TESTUSDT',
          interval: '1m',
          from: '2026-01-01T00:01:00Z',
          to: '2026-01-01T00:03:00Z',
        });

      expect(res.status).toBe(200);
      // Only candles within the range (minutes 1, 2, 3)
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.length).toBeLessThanOrEqual(3);
    });

    it('404 on unknown symbol', async () => {
      const res = await request(server)
        .get('/api/v1/market-data/ohlcv')
        .query({ symbol: 'DOESNOTEXIST', interval: '1m' });
      expect(res.status).toBe(404);
    });

    it('422 on invalid interval', async () => {
      const res = await request(server)
        .get('/api/v1/market-data/ohlcv')
        .query({ symbol: 'TESTUSDT', interval: '2x' });
      expect(res.status).toBe(422);
    });
  });

  // ── OHLCV upsert idempotency ───────────────────────────────────────────────

  describe('OHLCV upsert idempotency', () => {
    it('upserting the same candle twice does not duplicate rows', async () => {
      const candle = {
        symbolId,
        interval: '1m',
        openTime: new Date('2026-01-01T01:00:00Z'),
        open: '200',
        high: '210',
        low: '190',
        close: '205',
        volume: '500',
      };

      const where = { symbolId_interval_openTime: { symbolId, interval: '1m', openTime: candle.openTime } };
      await prisma.oHLCV.upsert({ where, create: candle, update: candle });
      await prisma.oHLCV.upsert({ where, create: candle, update: { close: '208' } });

      const row = await prisma.oHLCV.findUniqueOrThrow({ where });
      expect(row.close.toString()).toBe('208');

      // Clean up
      await prisma.oHLCV.delete({ where });
    });
  });
});
