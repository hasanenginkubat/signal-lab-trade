import type { Hlc } from "./atr";

export interface AdxResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

/**
 * Wilder ADX: trendin GÜCÜNÜ ölçer (yönünü değil). 20 altı yatay/kararsız piyasa,
 * 25 üstü güçlü trend kabul edilir. +DI > −DI yükseliş, tersi düşüş baskısıdır.
 */
export function adx(candles: Hlc[], period = 14): AdxResult {
  const n = candles.length;
  const adxOut = new Array<number>(n).fill(NaN);
  const plusOut = new Array<number>(n).fill(NaN);
  const minusOut = new Array<number>(n).fill(NaN);
  if (n <= period * 2) return { adx: adxOut, plusDi: plusOut, minusDi: minusOut };

  let trS = 0;
  let plusS = 0;
  let minusS = 0;
  const dx = new Array<number>(n).fill(NaN);

  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    const plusDm = up > down && up > 0 ? up : 0;
    const minusDm = down > up && down > 0 ? down : 0;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));

    if (i <= period) {
      trS += tr;
      plusS += plusDm;
      minusS += minusDm;
      if (i < period) continue;
    } else {
      trS = trS - trS / period + tr;
      plusS = plusS - plusS / period + plusDm;
      minusS = minusS - minusS / period + minusDm;
    }
    const pdi = trS ? (100 * plusS) / trS : 0;
    const mdi = trS ? (100 * minusS) / trS : 0;
    plusOut[i] = pdi;
    minusOut[i] = mdi;
    dx[i] = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  }

  // İlk ADX: ilk `period` DX değerinin ortalaması, sonrası Wilder yumuşatması
  const first = period * 2 - 1;
  let sum = 0;
  for (let i = period; i <= first; i++) sum += dx[i];
  let prev = sum / period;
  adxOut[first] = prev;
  for (let i = first + 1; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    adxOut[i] = prev;
  }
  return { adx: adxOut, plusDi: plusOut, minusDi: minusOut };
}
