import assert from "node:assert/strict";
import { test } from "node:test";
import { canOfferPlan, consensusLabel, describeTrack, type Candle } from "@signal-lab/shared";
import { planFromView, verdictFromView } from "../src/analysis/analyzer";
import { computePlan, dayStart, DEFAULT_CONSENSUS_PARAMS, evaluateConsensus, toWeekly, weekStart, type ConsensusInput } from "../src/signals/consensus";
import { trendOf } from "../src/signals/strategy";

const H = 3_600_000;
const END = Date.UTC(2026, 8, 30, 15); // salı 15:00 UTC
const P = DEFAULT_CONSENSUS_PARAMS;

function candles(interval: string, ms: number, n: number, end: number, price: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, k) => {
    const openTime = end - (n - k) * ms;
    const c = price(k);
    const o = k ? price(k - 1) : c;
    return { symbol: "T", interval, openTime, closeTime: openTime + ms - 1, open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 100, isClosed: true };
  });
}

/** Dalgalı yükseliş serisinde kapının geçtiği ilk anı bulur (filtreler gevşek) */
function findSignal(params = { ...P, minAdx: 0, aPlusMinAdx: 0 }) {
  const wave = (i: number) => 100 + i * 0.3 + 4 * Math.sin(i / 5);
  const all = candles("1h", H, 900, END, wave);
  for (let k = 0; k < all.length; k++) if (k % 10 === 0) all[k].volume = 400;
  for (let end = 400; end < all.length; end++) {
    const h1 = all.slice(end - 400, end);
    const t = h1[h1.length - 1].closeTime + 1;
    const input: ConsensusInput = {
      h1,
      m15: candles("15m", H / 4, 200, t, (i) => 100 + i * 0.05),
      h4: candles("4h", 4 * H, 300, t, (i) => 100 + i),
      d1: candles("1d", 24 * H, 400, t, (i) => 100 + i * 2),
      btc4h: candles("4h", 4 * H, 300, t, (i) => 100 + i),
      btc1d: candles("1d", 24 * H, 300, t, (i) => 100 + i * 2),
    };
    const r = evaluateConsensus(input, params);
    if (r.signal) return { input, r };
  }
  return null;
}

test("hafta pazartesi 00:00 UTC'de başlar, gün 00:00 UTC'de", () => {
  assert.equal(new Date(weekStart(END)).toISOString(), "2026-09-28T00:00:00.000Z");
  assert.equal(new Date(dayStart(END)).toISOString(), "2026-09-30T00:00:00.000Z");
});

test("toWeekly günlük mumları haftalara toplar", () => {
  const d1 = candles("1d", 24 * H, 14, Date.UTC(2026, 8, 28) + 7 * 24 * H, (i) => 100 + i);
  const w = toWeekly(d1);
  assert.equal(w.length, 2);
  assert.equal(w[0].close, d1[6].close);
});

// ---- Eski karar mantığı: oylar ve trend ----
test("trend (eski): fiyat > EMA50 ve EMA21 > EMA50 → YUKARI", () => {
  const up = candles("1d", 24 * H, 300, END, (i) => 100 + i);
  assert.equal(trendOf(up), "UP");
  const down = candles("1d", 24 * H, 300, END, (i) => (i < 260 ? 100 + i : 360 - (i - 260) * 4));
  assert.equal(trendOf(down), "DOWN");
});

test("eski oy seti ve ağırlıkları (haftalık/günlük 1.5, 4s/1s 1, 15dk 0.5, seviyeler 0.75, kırılım 1.5, momentum 1)", () => {
  const found = findSignal();
  assert.ok(found);
  const w = Object.fromEntries(found.r.votes.map((v) => [v.key, v.weight]));
  assert.equal(w.weekly, 1.5);
  assert.equal(w.daily, 1.5);
  assert.equal(w.h4, 1);
  assert.equal(w.h1, 1);
  assert.equal(w.m15, 0.5);
  assert.equal(w.vwap, 0.75);
  assert.equal(w.breakout, 1.5);
  assert.equal(w.momentum, 1);
  assert.ok(w.trendStrategy === 1 || w.trendStrategy === 2);
});

test("uyum yüzdesi agree/total oranıdır (9/11 → %100 yazmaz)", () => {
  const found = findSignal();
  assert.ok(found);
  const r = found.r;
  assert.equal(r.confidence, Math.round((r.agree / r.total) * 100));
  if (r.agree < r.total) assert.ok(r.confidence < 100);
});

// ---- Madde 1 + 7: ADX kapısı ----
test("ADX < minAdx: kapı geçmez, sinyal yok, karar en fazla NEUTRAL, plan yok, buton yok", () => {
  const found = findSignal();
  assert.ok(found);
  const adxNow = found.r.adx!;
  const r = evaluateConsensus(found.input, { ...P, minAdx: adxNow + 1, aPlusMinAdx: 99 });
  assert.equal(r.gate.passed, false);
  assert.equal(r.signal, null);
  assert.match(r.gate.blockedBy ?? "", /ADX/);
  assert.equal(r.gate.checks.find((c) => c.key === "adx")?.ok, false);
  const view = { passed: r.gate.passed, quality: null, plan: null, score: r.score };
  const verdict = verdictFromView(view, P.threshold);
  assert.ok(verdict === "NEUTRAL" || verdict === "AVOID", verdict);
  const plan = planFromView(view);
  assert.equal(plan, null);
  assert.equal(canOfferPlan({ verdict, plan }), false);
  // Etiket: skor yüksek olsa bile AL değil
  const label = consensusLabel(r.score, P.threshold, null, false);
  assert.ok(label !== "AL" && label !== "GÜÇLÜ AL", label);
});

test("kapı geçtiğinde karar BUY/STRONG_BUY, plan var ve buton gösterilir", () => {
  const found = findSignal();
  assert.ok(found?.r.signal);
  const s = found.r.signal;
  const view = { passed: true, quality: s.quality, plan: s.plan, score: found.r.score };
  const verdict = verdictFromView(view, P.threshold);
  assert.ok(verdict === "BUY" || verdict === "STRONG_BUY");
  assert.equal(verdict === "STRONG_BUY", s.quality === "A+");
  assert.ok(canOfferPlan({ verdict, plan: planFromView(view) }));
});

test("GÜÇLÜ AL yalnızca A+ (ADX ≥ 25, kırılım/2+ strateji, BTC aleyhte değil, rejim uygun)", () => {
  const found = findSignal();
  assert.ok(found?.r.signal);
  const weak = evaluateConsensus(found.input, { ...P, minAdx: 0, aPlusMinAdx: 99 });
  assert.equal(weak.signal?.quality, "A");
  assert.equal(consensusLabel(weak.score, P.threshold, { passed: true, quality: "A", side: "LONG" }, false), "AL");
  const btcDown = evaluateConsensus({ ...found.input, btc1d: candles("1d", 24 * H, 300, END, (i) => 2000 - i * 3) }, { ...P, minAdx: 0, aPlusMinAdx: 0 });
  if (btcDown.signal) {
    assert.equal(btcDown.signal.quality, "A");
    assert.ok(btcDown.signal.qualityNotes.some((n) => n.includes("rejimi uygun değil")));
  }
});

// ---- İşlem planı (eski kural) ----
function flat(): Candle[] {
  return Array.from({ length: 300 }, (_, k) => {
    const close = k === 299 ? 100 : 100 + Math.sin(k) * 0.2;
    return { symbol: "T", interval: "1h", openTime: k * H, closeTime: (k + 1) * H - 1, open: 100, high: 100.5, low: 99.5, close, volume: 1, isClosed: true };
  });
}

test("stop: son 8 mum dibi − 0.25×ATR, 1–2.5 ATR arası; TP = giriş + 1.5 × risk", () => {
  const h1 = flat();
  const plan = computePlan(h1, "LONG", 1, P);
  assert.equal(plan.entry, 100);
  // yapısal: 100 − (99.5 − 0.25) = 0.75 < 1 ATR → 1 ATR
  assert.ok(Math.abs(plan.entry - plan.stopLoss - 1) < 1e-9);
  assert.ok(Math.abs(plan.takeProfit - 101.5) < 1e-9);
  const deep = h1.map((c, k) => (k === 295 ? { ...c, low: 90 } : c));
  const capped = computePlan(deep, "LONG", 1, P);
  assert.ok(Math.abs(capped.entry - capped.stopLoss - 2.5) < 1e-9);
});

// ---- Madde 5: karne metni ----
test("karne: n < 30 ise oran yerine 'yetersiz veri'", () => {
  const base = { wins: 4, breakevens: 4, losses: 2, expired: 0, winRatePct: 40, breakevenPct: 40, lossPct: 20, expectancyPct: 0.1, profitFactor: 1.1 };
  assert.equal(describeTrack({ ...base, trades: 10, sufficient: false }).text, "yetersiz veri (n=10)");
  const ok = describeTrack({ ...base, trades: 30, sufficient: true });
  assert.equal(ok.sufficient, true);
  assert.match(ok.text, /%40 kazanç • %40 başa baş • %20 kayıp/);
});

test("etiketler: AL sadece kapı geçince; yüksek skor + kapı yok = İZLE; short kapalıyken düşüş = UZAK DUR", () => {
  assert.equal(consensusLabel(95, 70, null, false), "İZLE");
  assert.equal(consensusLabel(72, 70, { passed: true, quality: "A+", side: "LONG" }, false), "GÜÇLÜ AL");
  assert.equal(consensusLabel(72, 70, { passed: true, quality: "A", side: "LONG" }, false), "AL");
  assert.equal(consensusLabel(10, 70, null, false), "BEKLE");
  assert.equal(consensusLabel(-80, 70, null, false), "UZAK DUR");
});

test("verisi olmayan bileşen (ör. 15dk) toplam ağırlığa katılmaz", () => {
  const found = findSignal();
  assert.ok(found);
  const without = evaluateConsensus({ ...found.input, m15: [] }, { ...P, minAdx: 0, aPlusMinAdx: 0 });
  assert.ok(!without.votes.some((v) => v.key === "m15"));
  const total = without.votes.reduce((a, v) => a + v.weight, 0);
  const net = without.votes.reduce((a, v) => a + v.value * v.weight, 0);
  assert.equal(without.score, Math.round((net / total) * 100));
});
