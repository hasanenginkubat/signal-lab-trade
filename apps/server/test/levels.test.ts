import assert from "node:assert/strict";
import { test } from "node:test";
import { adx, findLevels } from "@signal-lab/shared";

test("adx güçlü trendde yüksek, +DI > −DI", () => {
  const candles = Array.from({ length: 80 }, (_, i) => ({ high: 101 + i, low: 99 + i, close: 100.5 + i }));
  const r = adx(candles, 14);
  const last = candles.length - 1;
  assert.ok(r.adx[last] > 50, `adx=${r.adx[last]}`);
  assert.ok(r.plusDi[last] > r.minusDi[last]);
  assert.ok(Number.isNaN(r.adx[10]));
});

test("adx yatay piyasada düşük", () => {
  const candles = Array.from({ length: 120 }, (_, i) => {
    const m = 100 + (i % 2 ? 1 : -1);
    return { high: m + 1, low: m - 1, close: m };
  });
  const r = adx(candles, 14);
  assert.ok(r.adx[119] < 20, `adx=${r.adx[119]}`);
});

test("findLevels tekrar eden tepe/dipleri birleştirir", () => {
  // 100 ile 110 arasında salınan seri: 110 direnç, 100 destek
  const candles = Array.from({ length: 100 }, (_, i) => {
    const phase = i % 20;
    const mid = phase < 10 ? 100 + phase : 120 - phase;
    return { high: mid + 0.2, low: mid - 0.2 };
  });
  const levels = findLevels(candles, 0.5, 3, 300);
  const top = levels.find((l) => Math.abs(l.price - 110.2) < 0.5);
  const bottom = levels.find((l) => Math.abs(l.price - 99.8) < 0.5);
  assert.ok(top && top.touches >= 3, JSON.stringify(levels));
  assert.ok(bottom && bottom.touches >= 3);
});
