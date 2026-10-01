/** Binance kline (mum) WebSocket yükü */
export interface BinanceKlineRaw {
  t: number; // açılış zamanı
  T: number; // kapanış zamanı
  s: string; // sembol
  i: string; // aralık
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  x: boolean; // mum kapandı mı
}

export interface BinanceKlineMessage {
  e: "kline";
  E: number;
  s: string;
  k: BinanceKlineRaw;
}

/** `!miniTicker@arr` akışındaki 24 saatlik özet */
export interface BinanceMiniTicker {
  e: "24hrMiniTicker";
  E: number;
  s: string;
  c: string; // son fiyat
  o: string;
  h: string;
  l: string;
  v: string;
  q: string; // USDT hacmi
}

/** Birleşik (combined) akış zarfı */
export interface BinanceCombinedMessage<T = unknown> {
  stream: string;
  data: T;
}

/** REST /klines satırı */
export type BinanceKlineRow = [
  number, // açılış zamanı
  string, // açılış
  string, // en yüksek
  string, // en düşük
  string, // kapanış
  string, // hacim
  number, // kapanış zamanı
  ...unknown[],
];

export interface BinanceTicker24h {
  symbol: string;
  lastPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  closeTime: number;
}
