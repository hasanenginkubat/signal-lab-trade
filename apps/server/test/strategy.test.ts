import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candle } from "@signal-lab/shared";
import { DEFAULT_PARAMS, evaluate } from "../src/signals/strategy";

// Sentetik seriler için filtreler gevşetilir; filtreler ayrı testlerde doğrulanır
const params = { ...DEFAULT_PARAMS, minAdx: 0, requireHigherTimeframe: false, allowShort: true };

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    symbol: "TEST",
    interval: "1h",
    openTime: i * 3_600_000,
    closeTime: (i + 1) * 3_600_000 - 1,
    open: i ? closes[i - 1] : c,
    high: Math.max(c, i ? closes[i - 1] : c) * 1.002,
    low: Math.min(c, i ? closes[i - 1] : c) * 0.998,
    close: c,
    volume: 100,
    isClosed: true,
  }));
}

test("yetersiz veride nötr döner", () => {
  const r = evaluate(series([1, 2, 3]), params);
  assert.equal(r.signal, null);
  assert.equal(r.trend, "NEUTRAL");
});

test("güçlü yükseliş trendinde pozitif skor ve UP trend", () => {
  const closes = Array.from({ length: 250 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 3));
  const r = evaluate(series(closes), params);
  assert.equal(r.trend, "UP");
  assert.ok(r.score > 0);
});

test("trend içinde geri çekilme sonrası dönüş LONG sinyali üretir, SL/TP doğru tarafta", () => {
  // Uzun yükseliş → kısa sert düşüş → toparlanma (EMA9/21 ve MACD yukarı kesişimi)
  const closes: number[] = [];
  for (let i = 0; i < 230; i++) closes.push(100 + i * 0.4);
  for (let i = 0; i < 12; i++) closes.push(closes[closes.length - 1] - 1.2);
  let found: ReturnType<typeof evaluate>["signal"] = null;
  for (let i = 0; i < 15 && !found; i++) {
    closes.push(closes[closes.length - 1] + 1.5);
    const r = evaluate(series(closes), params);
    if (r.signal) found = r.signal;
  }
  assert.ok(found, "sinyal bekleniyordu");
  assert.equal(found.side, "LONG");
  const last = closes[closes.length - 1];
  assert.ok(found.stopLoss < last && found.takeProfit > last);
  assert.ok(found.reasons.length > 0);
});

test("düşüş trendinde tepki sonrası SHORT sinyali", () => {
  const closes: number[] = [];
  for (let i = 0; i < 230; i++) closes.push(300 - i * 0.4);
  for (let i = 0; i < 12; i++) closes.push(closes[closes.length - 1] + 1.2);
  let found: ReturnType<typeof evaluate>["signal"] = null;
  for (let i = 0; i < 15 && !found; i++) {
    closes.push(closes[closes.length - 1] - 1.5);
    const r = evaluate(series(closes), params);
    if (r.signal) found = r.signal;
  }
  assert.ok(found, "sinyal bekleniyordu");
  assert.equal(found.side, "SHORT");
});

function pullbackLong(): number[] {
  const closes: number[] = [];
  for (let i = 0; i < 230; i++) closes.push(100 + i * 0.4);
  for (let i = 0; i < 12; i++) closes.push(closes[closes.length - 1] - 1.2);
  return closes;
}

function firstSignal(closes: number[], p: typeof params, higher?: Candle[]) {
  for (let i = 0; i < 15; i++) {
    closes.push(closes[closes.length - 1] + 1.5);
    const r = evaluate(series(closes), p, higher);
    if (r.signal) return r;
  }
  return null;
}

test("SHORT sinyalleri varsayılan olarak kapalı", () => {
  const closes: number[] = [];
  for (let i = 0; i < 230; i++) closes.push(300 - i * 0.4);
  for (let i = 0; i < 12; i++) closes.push(closes[closes.length - 1] + 1.2);
  for (let i = 0; i < 15; i++) {
    closes.push(closes[closes.length - 1] - 1.5);
    assert.equal(evaluate(series(closes), { ...params, allowShort: false }).signal, null);
  }
});

test("üst zaman dilimi düşüşteyse LONG sinyali engellenir", () => {
  const down = series(Array.from({ length: 120 }, (_, i) => 500 - i * 2));
  const blocked = firstSignal(pullbackLong(), { ...params, requireHigherTimeframe: true }, down);
  assert.equal(blocked, null);
  const up = series(Array.from({ length: 120 }, (_, i) => 100 + i * 2));
  const allowed = firstSignal(pullbackLong(), { ...params, requireHigherTimeframe: true }, up);
  assert.ok(allowed?.signal);
  assert.ok(allowed.signal.reasons.some((r) => r.includes("Üst zaman dilimi")));
});

test("hedef = risk × R oranı", () => {
  const r = firstSignal(pullbackLong(), { ...params, riskReward: 2 });
  assert.ok(r?.signal);
  const entry = r.snapshot!.close;
  const risk = entry - r.signal.stopLoss;
  assert.ok(Math.abs(r.signal.takeProfit - entry - 2 * risk) < 1e-9);
  // Stop en az 1 ATR uzakta
  assert.ok(risk >= r.snapshot!.atr - 1e-9);
});
