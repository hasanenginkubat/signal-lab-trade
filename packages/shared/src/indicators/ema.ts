/**
 * Üssel hareketli ortalama. İlk değer, ilk `period` geçerli değerin SMA'sı ile tohumlanır.
 * Baştaki NaN değerler atlanır (ör. MACD hattının EMA'sı alınırken).
 */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0) return out;
  const k = 2 / (period + 1);

  let start = 0;
  while (start < values.length && Number.isNaN(values[start])) start++;
  if (values.length - start < period) return out;

  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i];
  let prev = seed / period;
  out[start + period - 1] = prev;

  for (let i = start + period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
