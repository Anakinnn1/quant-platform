/** A single kline (candle) tick from Binance WebSocket or REST. */
export interface BinanceKlineTick {
  t: number; // open time (ms)
  T: number; // close time (ms)
  s: string; // symbol
  i: string; // interval
  o: string; // open price
  h: string; // high price
  l: string; // low price
  c: string; // close price
  v: string; // volume
  x: boolean; // is this candle closed?
}

/** Tick published to Redis and forwarded over SSE. */
export interface PriceTick {
  symbol: string;
  price: string;
  ts: string; // ISO-8601
}
