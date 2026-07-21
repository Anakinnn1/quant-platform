import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import Redis from 'ioredis';
import type { MessageEvent } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { OhlcvQueryDto } from './dto/ohlcv-query.dto';

@Injectable()
export class MarketDataService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  getSymbols() {
    return this.prisma.symbol.findMany({
      where: { isActive: true },
      select: { id: true, ticker: true, base: true, quote: true },
      orderBy: { ticker: 'asc' },
    });
  }

  async getOhlcv(query: OhlcvQueryDto) {
    const symbol = await this.prisma.symbol.findUnique({
      where: { ticker: query.symbol.toUpperCase() },
    });
    if (!symbol) throw new NotFoundException(`Symbol ${query.symbol} not found`);

    const limit = Math.min(query.limit ?? 100, 1000);

    const openTimeFilter: Record<string, Date> = {};
    if (query.from) openTimeFilter.gte = new Date(query.from);
    if (query.to) openTimeFilter.lte = new Date(query.to);
    if (query.cursor) openTimeFilter.gt = new Date(query.cursor);

    const rows = await this.prisma.oHLCV.findMany({
      where: {
        symbolId: symbol.id,
        interval: query.interval,
        ...(Object.keys(openTimeFilter).length && { openTime: openTimeFilter }),
      },
      orderBy: { openTime: 'asc' },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    return {
      data,
      nextCursor: hasMore ? data[data.length - 1].openTime.toISOString() : null,
    };
  }

  /**
   * Returns an Observable that forwards ticks from the Redis pub/sub channel
   * to the SSE client. Each subscriber gets its own Redis connection; the
   * teardown function disconnects it when the client closes.
   */
  subscribeLive(symbol: string): Observable<MessageEvent> {
    return new Observable((observer) => {
      const channel = `market:tick:${symbol.toUpperCase()}`;
      const sub = new Redis(this.config.get<string>('REDIS_URL', 'redis://localhost:6379'));

      sub.subscribe(channel, (err) => {
        if (err) observer.error(err);
      });

      sub.on('message', (_ch: string, msg: string) => {
        try {
          observer.next({ data: JSON.parse(msg) as object, type: 'price' } as MessageEvent);
        } catch {
          // ignore malformed messages
        }
      });

      sub.on('error', (err: Error) => observer.error(err));

      return () => {
        void sub.unsubscribe(channel).finally(() => sub.disconnect());
      };
    });
  }
}
