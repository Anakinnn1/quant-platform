import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { BinanceTestnetClient, BinanceTestnetWsManager } from '@quant/exchange';
import type { BinanceKlineTick } from '@quant/exchange';
import { PrismaClient } from '@prisma/client';

const SYMBOLS = [
  { ticker: 'BTCUSDT', base: 'BTC', quote: 'USDT' },
  { ticker: 'ETHUSDT', base: 'ETH', quote: 'USDT' },
];
const INTERVALS = ['1m'] as const;
const BACKFILL_LIMIT = 1000;

@Injectable()
export class IngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionService.name);
  private redis!: Redis;
  private wsManager!: BinanceTestnetWsManager;
  private readonly prisma = new PrismaClient();
  private readonly rest = new BinanceTestnetClient();

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    this.redis = new Redis(this.config.get<string>('REDIS_URL', 'redis://localhost:6379'));
    this.wsManager = new BinanceTestnetWsManager();

    await this.seedSymbols();

    const symbols = await this.prisma.symbol.findMany({ where: { isActive: true } });
    for (const symbol of symbols) {
      for (const interval of INTERVALS) {
        await this.startSymbol(symbol.id, symbol.ticker, interval);
      }
    }
    this.logger.log(`Ingestion started for ${symbols.length} symbol(s)`);
  }

  async onModuleDestroy() {
    this.wsManager.closeAll();
    await this.redis.quit();
    await this.prisma.$disconnect();
  }

  private async seedSymbols() {
    for (const s of SYMBOLS) {
      await this.prisma.symbol.upsert({
        where: { ticker: s.ticker },
        create: s,
        update: {},
      });
    }
  }

  private async startSymbol(symbolId: string, ticker: string, interval: string) {
    // Initial backfill before subscribing.
    await this.backfill(symbolId, ticker, interval);

    this.wsManager.subscribeKline(
      ticker,
      interval,
      (kline) => this.onKline(symbolId, ticker, kline),
      () => this.backfill(symbolId, ticker, interval), // backfill on every reconnect
    );
  }

  private async onKline(symbolId: string, ticker: string, kline: BinanceKlineTick) {
    // Publish every tick (open or closed) for live price SSE.
    const tick = {
      symbol: ticker,
      price: kline.c,
      ts: new Date(kline.T).toISOString(),
    };
    await this.redis.publish(`market:tick:${ticker}`, JSON.stringify(tick));

    // Persist only closed candles.
    if (kline.x) {
      await this.upsertOhlcv(symbolId, kline);
    }
  }

  private async backfill(symbolId: string, ticker: string, interval: string) {
    const last = await this.prisma.oHLCV.findFirst({
      where: { symbolId, interval },
      orderBy: { openTime: 'desc' },
      select: { openTime: true },
    });

    // Default: last 24 h of candles on first run.
    const startTime = last
      ? last.openTime.getTime() + 1
      : Date.now() - 24 * 60 * 60 * 1000;

    let klines: BinanceKlineTick[];
    try {
      klines = await this.rest.getKlines(ticker, interval, { startTime, limit: BACKFILL_LIMIT });
    } catch (err) {
      this.logger.warn(`Backfill failed for ${ticker}/${interval}: ${(err as Error).message}`);
      return;
    }

    let count = 0;
    for (const k of klines) {
      await this.upsertOhlcv(symbolId, k);
      count++;
    }
    if (count) this.logger.log(`Backfilled ${count} candles for ${ticker}/${interval}`);
  }

  private async upsertOhlcv(symbolId: string, k: BinanceKlineTick) {
    await this.prisma.oHLCV.upsert({
      where: {
        symbolId_interval_openTime: {
          symbolId,
          interval: k.i,
          openTime: new Date(k.t),
        },
      },
      create: {
        symbolId,
        interval: k.i,
        openTime: new Date(k.t),
        open: k.o,
        high: k.h,
        low: k.l,
        close: k.c,
        volume: k.v,
      },
      update: { open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v },
    });
  }
}
