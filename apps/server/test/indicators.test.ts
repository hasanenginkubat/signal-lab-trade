import assert from "node:assert/strict";
import { test } from "node:test";
import { atr, bollinger, ema, macd, rsi, sma } from "@signal-lab/shared";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("sma", () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(out[1]));
  assert.deepEqual(out.slice(2), [2, 3, 4]);
});

test("ema SMA ile tohumlanır ve ardından üssel ilerler", () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  close(out[2], 2);
  close(out[3], 3); // 4*0.5 + 2*0.5
  close(out[4], 4);
});

test("rsi sürekli yükselişte 100, düşüşte 0", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  close(rsi(up)[29], 100);
  close(rsi(down)[29], 0);
  assert.ok(Number.isNaN(rsi(up)[13]));
});

test("rsi bilinen değer (Wilder örneği)", () => {
  const data = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
  ];
  close(rsi(data)[14], 70.46, 0.05);
});

test("bollinger sabit seride bantlar ortalamaya eşit", () => {
  const bb = bollinger(new Array(25).fill(10), 20, 2);
  close(bb.upper[24], 10);
  close(bb.lower[24], 10);
});

test("macd hattı = hızlı EMA − yavaş EMA", () => {
  const data = Array.from({ length: 60 }, (_, i) => Math.sin(i / 5) * 10 + 100);
  const m = macd(data);
  const diff = ema(data, 12)[59] - ema(data, 26)[59];
  close(m.macd[59], diff);
  close(m.histogram[59], m.macd[59] - m.signal[59]);
});

test("atr sabit aralıklı mumlarda aralığa eşit", () => {
  const candles = Array.from({ length: 30 }, () => ({ high: 11, low: 9, close: 10 }));
  close(atr(candles)[29], 2);
});
