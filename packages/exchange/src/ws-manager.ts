import WebSocket from 'ws';
import { nextBackoff, initialBackoff } from './backoff.js';
import type { BinanceKlineTick } from './types.js';

// Testnet-only: URL is a constant, not a parameter.
const WS_BASE = 'wss://testnet.binance.vision/ws' as const;

type OnTick = (k: BinanceKlineTick) => void | Promise<void>;
type OnReconnect = () => void | Promise<void>;

interface Subscription {
  ws: WebSocket;
  closed: boolean;
}

export class BinanceTestnetWsManager {
  private subs = new Map<string, Subscription>();

  subscribeKline(
    symbol: string,
    interval: string,
    onTick: OnTick,
    onReconnect?: OnReconnect,
  ): void {
    const key = `${symbol.toLowerCase()}@kline_${interval}`;
    let backoffMs = initialBackoff();

    const connect = (): void => {
      if (this.subs.get(key)?.closed === false) return; // already running

      const url = `${WS_BASE}/${key}`;
      const ws = new WebSocket(url);
      this.subs.set(key, { ws, closed: false });

      ws.on('open', () => {
        backoffMs = initialBackoff(); // reset on clean connect
        console.log(`[WS] connected ${key}`);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as { k: BinanceKlineTick };
          void onTick(msg.k);
        } catch {
          // ignore parse errors — Binance occasionally sends non-JSON ping frames
        }
      });

      ws.on('error', (err) => {
        console.error(`[WS] error ${key}: ${err.message}`);
      });

      ws.on('close', () => {
        const sub = this.subs.get(key);
        if (sub) sub.closed = true;

        const delay = backoffMs;
        backoffMs = nextBackoff(backoffMs);
        console.log(`[WS] disconnected ${key}, reconnecting in ${Math.round(delay)}ms`);

        setTimeout(() => {
          // Fire-and-forget backfill; connect immediately regardless of backfill outcome.
          if (onReconnect) void Promise.resolve(onReconnect()).catch(() => undefined);
          connect();
        }, delay);
      });
    };

    connect();
  }

  closeAll(): void {
    for (const [, sub] of this.subs) {
      sub.ws.removeAllListeners();
      sub.ws.close();
    }
    this.subs.clear();
  }
}
