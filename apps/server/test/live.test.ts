import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { persistableSettings, restoreSettings, type Candle, type Signal } from "@signal-lab/shared";
import { config } from "../src/config";
import { balanceEffectPct, basketValue, holdValue, LiveScorecard, maxDrawdownPct, type LiveDeps } from "../src/live/liveScorecard";

const H = 3_600_000;
const START = Date.UTC(2026, 9, 5, 10, 0); // Pazartesi 10:00 UTC
const OPTS = { trackingStart: START, riskPct: 1, quality: "A+" as const };

/** Bilinen fiyatlar: başlangıç BTC 100, ETH 10, SOL 2; ardından saatlik kapanışlar */
const START_PRICE: Record<string, number> = { BTCUSDT: 100, ETHUSDT: 10, SOLUSDT: 2 };
const HOURLY: Record<string, number[]> = {
  BTCUSDT: [110, 99, 105],
  ETHUSDT: [12, 9, 10],
  SOLUSDT: [2, 2, 3],
};

function deps(now: number, calls = { priceAt: 0 }): LiveDeps {
  return {
    now: () => now,
    priceAt: async (symbol) => (calls.priceAt++, START_PRICE[symbol] ?? null),
    fetchCandles: async (symbol, from, to) =>
      (HOURLY[symbol] ?? [])
        .map((close, k): Candle => {
          const openTime = START + k * H;
          return { symbol, interval: "1h", openTime, closeTime: openTime + H - 1, open: close, high: close, low: close, close, volume: 1, isClosed: true };
        })
        .filter((c) => c.openTime >= from && c.closeTime < to),
  };
}

function signal(over: Partial<Signal>): Signal {
  return {
    id: "s1", symbol: "ETHUSDT", interval: "1h", side: "LONG", price: 100, candleTime: START, createdAt: START + 1000,
    strength: 50, score: 80, reasons: [], stopLoss: 98, takeProfit: 103, status: "TP_HIT", closedAt: START + 2 * H,
    closePrice: 103, resultPct: 3 - 0.14, initialStopLoss: 98, kind: "consensus", quality: "A+", ...over,
  };
}

test("al-tut: BTC 100→110 = 110; sepet (eşit ağırlık, dengelemesiz) elle hesapla doğrulanır", () => {
  assert.equal(holdValue(100, 110), 110);
  assert.equal(holdValue(50_000, 45_000), 90);
  // ETH 10→12 (120), SOL 2→2 (100), BTC 100→99 (99) → (120 + 100 + 99) / 3 = 106.333…
  const v = basketValue([
    { startPrice: 10, price: 12 },
    { startPrice: 2, price: 2 },
    { startPrice: 100, price: 99 },
  ]);
  assert.ok(Math.abs(v - 319 / 3) < 1e-9);
  // 110 → 99: %10 düşüş
  assert.ok(Math.abs(maxDrawdownPct([100, 110, 99, 105]) - 10) < 1e-9);
  // Bakiye etkisi: stop %2, net +%2.86 → 1.43R → %1 riskle bakiyeye +%1.43
  assert.ok(Math.abs(balanceEffectPct(100, 98, 2.86, 1) - 1.43) < 1e-9);
});

test("canlı karne: saatlik al-tut eğrisi, bot bakiyesi ve haftalık tablo bilinen fiyatlarla", async () => {
  const live = new LiveScorecard(mkdtempSync(join(tmpdir(), "live-")), OPTS, deps(START + 3 * H + 60_000));
  await live.init(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  live.onSignal(signal({}));
  await live.sync();
  const r = live.report();
  // Noktalar: başlangıç + 3 saat
  assert.deepEqual(r.points.slice(0, 4).map((p) => Math.round(p.btc * 1000) / 1000), [100, 110, 99, 105]);
  // 3. saat sepeti: BTC 105, ETH 100, SOL 150 → 118.333…
  assert.ok(Math.abs(r.points[3].basket - 355 / 3) < 1e-9);
  assert.ok(Math.abs(r.summary.btcReturnPct - 5) < 1e-9);
  assert.ok(Math.abs(r.summary.btcMaxDdPct - 10) < 1e-9);
  assert.ok(Math.abs(r.summary.botReturnPct - 1.43) < 1e-9);
  assert.equal(r.summary.trades, 1);
  assert.equal(r.summary.wins, 1);
  assert.equal(r.summary.sufficient, false);
  // Hafta: Pazartesi 00:00 UTC (TR 03:00) başlangıçlı tek satır
  assert.equal(r.weeks.length, 1);
  assert.equal(new Date(r.weeks[0].weekStart).toISOString(), "2026-10-05T00:00:00.000Z");
  assert.ok(Math.abs(r.weeks[0].btcPct - 5) < 1e-9);
  assert.ok(Math.abs(r.weeks[0].diffPct - (1.43 - 5)) < 1e-9);
});

test("yalnızca A+ ve trackingStart sonrası sinyaller sayılır; aynı sinyal iki kez yazılmaz", async () => {
  const live = new LiveScorecard(mkdtempSync(join(tmpdir(), "live-")), OPTS, deps(START + 3 * H));
  await live.init(["BTCUSDT"]);
  live.onSignal(signal({}));
  live.onSignal(signal({})); // tekrar
  live.onSignal(signal({ id: "a", quality: "A" }));
  live.onSignal(signal({ id: "old", createdAt: START - H }));
  live.onSignal(signal({ id: "open", status: "OPEN", closedAt: null, closePrice: null, resultPct: null }));
  live.onSignal(signal({ id: "be", status: "SL_HIT", stopMoved: true, stopLoss: 100, closePrice: 100, resultPct: -0.14 }));
  const r = live.report();
  assert.deepEqual(r.trades.map((t) => t.id).sort(), ["be", "s1"]);
  assert.equal(r.trades.find((t) => t.id === "be")?.outcome, "BE");
  assert.equal(r.trades.find((t) => t.id === "be")?.stopLoss, 98); // ilk stop saklanır
});

test("sunucu yeniden başlatılınca işlem geçmişi, trackingStart ve sabit sepet korunur", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-"));
  const calls = { priceAt: 0 };
  const a = new LiveScorecard(dir, OPTS, deps(START + 3 * H, calls));
  await a.init(["BTCUSDT", "ETHUSDT"]);
  a.onSignal(signal({}));
  await a.sync();
  a.stop(); // kapanış: diske yaz
  const before = a.report();

  // Yeniden başlatma: farklı tarama listesiyle bile sepet değişmez, başlangıç fiyatları tekrar alınmaz
  const priceCallsBefore = calls.priceAt;
  const b = new LiveScorecard(dir, OPTS, deps(START + 3 * H, calls));
  await b.init(["DOGEUSDT", "XRPUSDT"]);
  const after = b.report();
  assert.equal(calls.priceAt, priceCallsBefore);
  assert.equal(b.trackingStart, START);
  assert.equal(after.trackingStart, START);
  assert.deepEqual(after.basket, ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(after.trades, before.trades);
  assert.deepEqual(after.points, before.points);
  const onDisk = JSON.parse(readFileSync(join(dir, "live-scorecard.json"), "utf8"));
  assert.equal(onDisk.trackingStart, START);
  assert.equal(onDisk.trades.length, 1);

  // trackingStart yapılandırması sabit bir andır (her açılışta aynı değer)
  assert.ok(Number.isFinite(config.live.trackingStart));
});

test("trackingStart değişirse eski kayıtlar karneye girmez (sıfırdan başlar)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-"));
  const a = new LiveScorecard(dir, OPTS, deps(START + 3 * H));
  await a.init(["BTCUSDT"]);
  a.onSignal(signal({}));
  a.stop();
  const b = new LiveScorecard(dir, { ...OPTS, trackingStart: START + 10 * H }, deps(START + 12 * H));
  assert.equal(b.report().trades.length, 0);
});

test("seçici mod (sadece A+) varsayılan açık ve yeniden başlatma/yenileme sonrası yine açık", () => {
  assert.equal(config.selective.aPlusOnly, true);
  const defaults = { riskPct: 1, leverage: 1, onlyAPlus: true, maxHoldHours: 48 };
  // Kullanıcı modu kapatıp kaldıracı 3 yaptı; tarayıcıya yazılan ayar seçici modu içermez
  const userChanged = { ...defaults, onlyAPlus: false, leverage: 3 };
  const file = join(mkdtempSync(join(tmpdir(), "ui-")), "settings.json");
  writeFileSync(file, JSON.stringify(persistableSettings(userChanged)));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal("onlyAPlus" in saved, false);
  // Sayfa yenilendi / sunucu yeniden başladı: seçici mod sunucu varsayılanına (A+) döner, diğer ayarlar korunur
  const restored = restoreSettings(defaults, saved, config.selective.aPlusOnly);
  assert.equal(restored.onlyAPlus, true);
  assert.equal(restored.leverage, 3);
  // Eski sürümden kalan kayıtta onlyAPlus:false olsa bile
  assert.equal(restoreSettings(defaults, { onlyAPlus: false }, config.selective.aPlusOnly).onlyAPlus, true);
});
