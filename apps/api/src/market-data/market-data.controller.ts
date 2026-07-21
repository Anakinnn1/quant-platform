import { Controller, Get, Param, Query, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { MarketDataService } from './market-data.service';
import { OhlcvQueryDto } from './dto/ohlcv-query.dto';

@Controller('market-data')
export class MarketDataController {
  constructor(private marketData: MarketDataService) {}

  @Get('symbols')
  getSymbols() {
    return this.marketData.getSymbols();
  }

  @Get('ohlcv')
  getOhlcv(@Query() query: OhlcvQueryDto) {
    return this.marketData.getOhlcv(query);
  }

  /**
   * SSE stream of live price ticks for a symbol.
   * Public endpoint — EventSource in browsers cannot set Authorization headers.
   * Per §9: event: price, data: { symbol, price, ts }
   */
  @Sse('live/:symbol')
  livePrice(@Param('symbol') symbol: string): Observable<MessageEvent> {
    return this.marketData.subscribeLive(symbol);
  }
}
