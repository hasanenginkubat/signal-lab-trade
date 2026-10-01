import { ema } from "./ema";

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => fastEma[i] - slowEma[i]);
  const signal = ema(line, signalPeriod);
  const histogram = line.map((v, i) => v - signal[i]);
  return { macd: line, signal, histogram };
}
