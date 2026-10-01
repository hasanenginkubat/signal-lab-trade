export interface Hl {
  high: number;
  low: number;
}

export interface Level {
  price: number;
  /** Bu seviyeye kaç kez dokunulduğu (güç) */
  touches: number;
  /** Son dokunuşun mum indeksi */
  lastIndex: number;
}

/**
 * Pivot (dönüş) noktalarından destek/direnç seviyeleri çıkarır: her iki yanındaki `wing`
 * mumdan daha yüksek tepe ve daha düşük dipler bulunur, birbirine `tolerance` (fiyat birimi)
 * kadar yakın olanlar tek seviyede birleştirilir.
 */
export function findLevels(candles: Hl[], tolerance: number, wing = 3, lookback = 300): Level[] {
  const start = Math.max(wing, candles.length - lookback);
  const pivots: { price: number; index: number }[] = [];
  for (let i = start; i < candles.length - wing; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= wing; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high < candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low > candles[i + j].low) isLow = false;
    }
    if (isHigh) pivots.push({ price: candles[i].high, index: i });
    if (isLow) pivots.push({ price: candles[i].low, index: i });
  }

  pivots.sort((a, b) => a.price - b.price);
  const levels: Level[] = [];
  for (const p of pivots) {
    const last = levels[levels.length - 1];
    if (last && Math.abs(p.price - last.price) <= tolerance) {
      last.price = (last.price * last.touches + p.price) / (last.touches + 1);
      last.touches += 1;
      last.lastIndex = Math.max(last.lastIndex, p.index);
    } else {
      levels.push({ price: p.price, touches: 1, lastIndex: p.index });
    }
  }
  return levels;
}
