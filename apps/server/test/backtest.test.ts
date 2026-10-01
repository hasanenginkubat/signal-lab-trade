import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Candle, Signal } from "@signal-lab/shared";
import {
  buyHoldPct,
  DEFAULT_BACKTEST_OPTIONS,
  equityCurve,
  isMissed,
  roundTripCostPct,
  simulate,
  simulateLimit,
  stats,
} from "../src/backtest/backtest";
import { backtestConsensus } from "../src/backtest/consensusBacktest";
import { SignalTracker } from "../src/scorecard/tracker";
import { DEFAULT_CONSENSUS_PARAMS } from "../src/signals/consensus";

const H = 3_600_000;
const bar = (i: number, high: number, low: number, close: number): Candle => ({
  symbol: "T",
  interval: "1h",
  openTime: i * H,
  closeTime: (i + 1) * H - 1,
  open: close,
  high,
  low,
  close,
  volume: 1,
  isClosed: true,
});
const COST = roundTripCostPct({ takerFeePct: 0.05, slippagePct: 0.02 });
const opts = { ...DEFAULT_BACKTEST_OPTIONS, expiryCandles: 5, roundTripFeePct: COST };
const flat = (from: number, n: number, p: number) => Array.from({ length: n }, (_, k) => bar(from + k, p, p, p));

test("maliyet modeli: giriş + çıkış taker %0.05 ve kayma %0.02/taraf = %0.14", () => {
  assert.ok(Math.abs(COST - 0.14) < 1e-12);
  assert.ok(Math.abs(DEFAULT_BACKTEST_OPTIONS.roundTripFeePct - 0.14) < 1e-12);
});

test("TP önce gelirse kazanç; net = brüt − maliyet", () => {
  const c = [bar(0, 100, 100, 100), bar(1, 116, 99, 110), ...flat(2, 5, 110)];
  const t = simulate(c, 0, "LONG", 90, 115, { ...opts, breakevenAtR: 0 })!;
  assert.equal(t.outcome, "TP");
  assert.ok(Math.abs(t.netPct - (15 - 0.14)) < 1e-9);
  assert.equal(t.exitIndex, 1);
});

test("aynı mumda SL ve TP → kötümser: SL", () => {
  const c = [bar(0, 100, 100, 100), bar(1, 120, 85, 100), ...flat(2, 5, 100)];
  assert.equal(simulate(c, 0, "LONG", 90, 115, opts)?.outcome, "SL");
});

test("aynı mumda 1R (başa baş tetiği) ve stop → kötümser: önce STOP (BE değil)", () => {
  // risk 10: mum hem 110'a (1R) hem 89'a (stop) değiyor
  const c = [bar(0, 100, 100, 100), bar(1, 111, 89, 100), ...flat(2, 5, 100)];
  const t = simulate(c, 0, "LONG", 90, 115, { ...opts, breakevenAtR: 1 })!;
  assert.equal(t.outcome, "SL");
  assert.ok(t.netPct < -10);
});

test("başa baş çıkış ücret sonrası NEGATİF (stop tam girişte)", () => {
  // 1R = 110'a gidip girişin altına (99) düşüyor
  const c = [bar(0, 100, 100, 100), bar(1, 111, 100.5, 109), bar(2, 109, 99, 100), ...flat(3, 5, 100)];
  const t = simulate(c, 0, "LONG", 90, 115, { ...opts, breakevenAtR: 1 })!;
  assert.equal(t.outcome, "BE");
  assert.equal(t.exit, 100);
  assert.ok(t.netPct < 0, `BE net ${t.netPct}`);
  assert.ok(Math.abs(t.netPct + 0.14) < 1e-9);
});

test("akıllı giriş: dolar ve limit fiyatından girer; dolmadan hedefe kaçarsa 'missed'", () => {
  const filled = [bar(0, 100, 100, 100), bar(1, 100.5, 98.9, 99.5), bar(2, 116, 99, 115), ...flat(3, 6, 115)];
  const t = simulateLimit(filled, 0, "LONG", 99, 90, 115, { ...opts, breakevenAtR: 0 });
  assert.ok(t && !isMissed(t));
  assert.equal(t.entry, 99);
  assert.equal(t.outcome, "TP");
  const ran = [bar(0, 100, 100, 100), bar(1, 116, 100, 115), ...flat(2, 8, 115)];
  const m = simulateLimit(ran, 0, "LONG", 99, 90, 115, opts);
  assert.ok(isMissed(m));
  assert.equal(m.at, 1);
});

test("karne: kazanç yalnızca TP; BE ve kayıp ayrı (4 TP + 4 BE + 2 SL = %40 kazanç, %80 değil)", () => {
  const mk = (outcome: "TP" | "BE" | "SL", netPct: number) => ({ outcome, netPct });
  const s = stats([...Array(4).fill(mk("TP", 3)), ...Array(4).fill(mk("BE", -0.14)), ...Array(2).fill(mk("SL", -2))]);
  assert.equal(s.trades, 10);
  assert.equal(s.wins, 4);
  assert.equal(s.breakevens, 4);
  assert.equal(s.losses, 2);
  assert.equal(s.winRatePct, 40);
  assert.equal(s.breakevenPct, 40);
  assert.equal(s.lossPct, 20);
  assert.equal(s.sufficient, false); // n < 30
  assert.ok(Math.abs(s.profitFactor - 12 / (4 * 0.14 + 4)) < 1e-9);
});

test("equity eğrisi: %1 risk, R bazlı; en büyük düşüş ve al-tut", () => {
  // stop mesafesi %2: −2% net = −1R → −%1, +3% net = +1.5R → +%1.5
  const t = (netPct: number, exitTime: number) => ({ entry: 100, stopLoss: 98, netPct, exitTime });
  const eq = equityCurve([t(-2, 1), t(-2, 2), t(3, 3)], 1);
  assert.ok(Math.abs(eq.maxDrawdownPct - (1 - 0.99 * 0.99) * 100) < 1e-9);
  assert.ok(eq.returnPct > -1);
  const c = [bar(0, 100, 100, 100), bar(1, 120, 100, 120)];
  c[0].open = 100;
  assert.equal(buyHoldPct(c, 0, 2 * H), 20);
});

test("aynı coinde çakışan işlem yok; cooldown pozisyon KAPANIŞINDAN sayılır", () => {
  const wave = (i: number) => 100 + i * 0.3 + 4 * Math.sin(i / 5);
  const n = 1200;
  const mk = (ms: number, count: number, price: (i: number) => number, interval: string) =>
    Array.from({ length: count }, (_, k) => {
      const openTime = n * H - (count - k) * ms;
      const cl = price(k);
      const o = k ? price(k - 1) : cl;
      return { symbol: "T", interval, openTime, closeTime: openTime + ms - 1, open: o, high: Math.max(o, cl) * 1.001, low: Math.min(o, cl) * 0.999, close: cl, volume: k % 10 === 0 ? 400 : 100, isClosed: true };
    });
  const h1 = mk(H, n, wave, "1h");
  const data = { h1, m15: [], h4: mk(4 * H, 400, (i) => 100 + i, "4h"), d1: mk(24 * H, 400, (i) => 100 + i * 2, "1d") };
  const params = { ...DEFAULT_CONSENSUS_PARAMS, minAdx: 0, aPlusMinAdx: 0 };
  const cooldown = 6;
  const trades = backtestConsensus(data, params, { ...DEFAULT_BACKTEST_OPTIONS, cooldownCandles: cooldown }, { smartEntry: true });
  assert.ok(trades.length >= 2, `en az 2 işlem bekleniyordu (${trades.length})`);
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1];
    const cur = sorted[k];
    assert.ok(cur.entryTime > prev.exitTime, `çakışma: ${new Date(cur.entryTime).toISOString()} < ${new Date(prev.exitTime).toISOString()}`);
    // Yeni sinyal mumu, önceki çıkıştan en az `cooldown` mum sonra
    assert.ok(cur.time - prev.exitTime >= (cooldown - 1) * H, "cooldown kapanıştan sayılmalı");
  }
});

// ---- Canlı takipçi: backtest ile aynı kurallar ----
function trackerSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: "s1", symbol: "T", interval: "1h", side: "LONG", price: 100, candleTime: 0, createdAt: 1000,
    strength: 50, score: 80, reasons: [], stopLoss: 90, takeProfit: 115, status: "OPEN",
    closedAt: null, closePrice: null, resultPct: null, initialStopLoss: 90, kind: "consensus", ...over,
  };
}
const m1 = (t: number, high: number, low: number, close = low): Candle => ({
  symbol: "T", interval: "1m", openTime: t, closeTime: t + 59_999, open: close, high, low, close, volume: 1, isClosed: true,
});

test("takipçi: akıllı giriş limitten dolar, 1R'de stop GİRİŞE taşınır, başa baş net eksi", () => {
  const tr = new SignalTracker(mkdtempSync(join(tmpdir(), "trk-")), 48, 1, COST);
  const s = trackerSignal({ entryLimit: 99, entryValidUntil: 10_000_000 });
  tr.add(s);
  tr.onCandle(m1(60_000, 100.5, 98.8));
  assert.equal(s.fillPrice, 99);
  tr.onCandle(m1(120_000, 108.5, 100)); // 1R = 99 + 9 = 108
  assert.equal(s.stopMoved, true);
  assert.equal(s.stopLoss, 99);
  tr.onCandle(m1(180_000, 100, 98.5));
  assert.equal(s.status, "SL_HIT");
  assert.ok((s.resultPct ?? 0) < 0, `BE net ${s.resultPct}`);
});

test("takipçi: akıllı giriş dolmadan fiyat hedefe giderse MISSED", () => {
  const tr = new SignalTracker(mkdtempSync(join(tmpdir(), "trk-")), 48, 1, COST);
  const s = trackerSignal({ entryLimit: 99, entryValidUntil: 10_000_000 });
  tr.add(s);
  tr.onCandle(m1(60_000, 115.5, 100.5));
  assert.equal(s.status, "MISSED");
  assert.equal(s.resultPct, null);
});

test("takipçi: açık sinyal varken ve kapanıştan sonraki cooldown boyunca yeni sinyal engellenir", () => {
  const tr = new SignalTracker(mkdtempSync(join(tmpdir(), "trk-")), 48, 1, COST);
  const s = trackerSignal();
  tr.add(s);
  assert.equal(tr.positionBlock("T", 5 * H, 6 * H), true);
  tr.onCandle(m1(60_000, 116, 100)); // hedef
  assert.equal(s.status, "TP_HIT");
  const closedAt = s.closedAt!;
  assert.equal(tr.positionBlock("T", closedAt + 2 * H, 6 * H), true);
  assert.equal(tr.positionBlock("T", closedAt + 6 * H, 6 * H), false);
  assert.equal(tr.positionBlock("X", closedAt, 6 * H), false);
});
