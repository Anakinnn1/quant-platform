'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

interface Tick {
  symbol: string;
  price: string;
  ts: string;
}

function useLivePrice(symbol: string) {
  const [tick, setTick] = useState<Tick | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`${API_URL}/api/v1/market-data/live/${symbol}`);
    esRef.current = es;

    es.addEventListener('price', (e) => {
      try {
        setTick(JSON.parse((e as MessageEvent).data) as Tick);
        setStatus('connected');
      } catch { /* ignore */ }
    });

    es.onerror = () => setStatus('error');

    return () => es.close();
  }, [symbol]);

  return { tick, status };
}

function PriceCard({ symbol }: { symbol: string }) {
  const { tick, status } = useLivePrice(symbol);

  const dot =
    status === 'connected' ? '#22c55e'
    : status === 'error' ? '#ef4444'
    : '#f59e0b';

  return (
    <div style={{
      background: '#1a1a2e',
      border: '1px solid #2d2d4e',
      borderRadius: 12,
      padding: '24px 32px',
      minWidth: 260,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, display: 'inline-block' }} />
        <span style={{ fontSize: 13, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1 }}>
          {symbol}
        </span>
      </div>
      <div style={{ fontSize: 40, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {tick ? `$${parseFloat(tick.price).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
      </div>
      {tick && (
        <div style={{ fontSize: 11, color: '#475569', marginTop: 8 }}>
          {new Date(tick.ts).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

export default function LivePage() {
  return (
    <main style={{ padding: '48px 32px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 32, color: '#f8fafc' }}>
        Live Prices
      </h1>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {SYMBOLS.map((s) => <PriceCard key={s} symbol={s} />)}
      </div>
      <p style={{ marginTop: 32, fontSize: 12, color: '#334155' }}>
        Binance Testnet · SSE stream via worker → Redis → API → browser
      </p>
    </main>
  );
}
