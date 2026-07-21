import { createHmac } from 'crypto';
import type { BinanceKlineTick } from './types';

// Testnet-only: URL is a constant, not a parameter — mainnet is structurally unreachable.
const REST_BASE = 'https://testnet.binance.vision/api/v3' as const;

export class BinanceTestnetClient {
  async getKlines(
    symbol: string,
    interval: string,
    params: { limit?: number; startTime?: number; endTime?: number } = {},
  ): Promise<BinanceKlineTick[]> {
    const qs = new URLSearchParams({ symbol: symbol.toUpperCase(), interval });
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.startTime) qs.set('startTime', String(params.startTime));
    if (params.endTime) qs.set('endTime', String(params.endTime));

    const res = await fetch(`${REST_BASE}/klines?${qs}`);
    if (!res.ok) throw new Error(`Binance REST klines ${res.status}`);

    const raw = (await res.json()) as unknown[][];
    return raw.map((r) => ({
      t: r[0] as number,
      T: r[6] as number,
      s: symbol.toUpperCase(),
      i: interval,
      o: r[1] as string,
      h: r[2] as string,
      l: r[3] as string,
      c: r[4] as string,
      v: r[5] as string,
      x: true, // REST klines are always closed candles
    }));
  }

  async getExchangeInfo(): Promise<{
    symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; status: string }>;
  }> {
    const res = await fetch(`${REST_BASE}/exchangeInfo`);
    if (!res.ok) throw new Error(`Binance REST exchangeInfo ${res.status}`);
    return res.json() as Promise<{
      symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; status: string }>;
    }>;
  }

  async getAccountBalance(
    apiKey: string,
    apiSecret: string,
  ): Promise<Array<{ asset: string; free: string; locked: string }>> {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = createHmac('sha256', apiSecret).update(queryString).digest('hex');

    const res = await fetch(`${REST_BASE}/account?${queryString}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey },
    });

    if (!res.ok) {
      const body = (await res.json()) as { msg?: string };
      throw new Error(`Binance API error: ${body.msg ?? res.status}`);
    }

    const account = (await res.json()) as {
      balances: Array<{ asset: string; free: string; locked: string }>;
    };
    return account.balances.filter((b) => +b.free > 0 || +b.locked > 0);
  }
}
