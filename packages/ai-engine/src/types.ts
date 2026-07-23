export interface OhlcvBar {
  openTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  interval: string;
}

export interface AISignalRequest {
  symbol: string;
  currentPrice?: number;
  recentOhlcv: OhlcvBar[];
  strategyName?: string;
}
