import type { Interval } from "./types";

/** Binance USDⓈ-M Futures üzerinde işlem gören varsayılan semboller. */
export const DEFAULT_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "DOTUSDT",
  "TRXUSDT",
  "LTCUSDT",
  "SUIUSDT",
  "NEARUSDT",
  "APTUSDT",
  "ARBUSDT",
  "OPUSDT",
  "INJUSDT",
  "ATOMUSDT",
  "FILUSDT",
] as const;

export const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

/** Sinyal motorunun varsayılan olarak çalıştığı aralıklar. */
export const DEFAULT_SIGNAL_INTERVALS: Interval[] = ["15m", "1h", "4h"];

export const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export const INTERVAL_LABELS: Record<Interval, string> = {
  "1m": "1dk",
  "5m": "5dk",
  "15m": "15dk",
  "1h": "1s",
  "4h": "4s",
  "1d": "1G",
};

export const MAX_LEVERAGE = 125;
export const MIN_NOTIONAL_USDT = 5;

export function isInterval(value: unknown): value is Interval {
  return typeof value === "string" && (INTERVALS as string[]).includes(value);
}
