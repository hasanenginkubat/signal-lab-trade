import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountState, Signal, Trade } from "@signal-lab/shared";
import { writeMarketReport, writeSignalNote } from "../src/analysis/writer";
import { computeGuard } from "../src/trading/guard";

const cfg = { enabled: true, maxOpen: 5, dayStopLosses: 2, breakerLosses: 4, pauseDays: 3, requireBtcUp: true };
const NOW = Date.UTC(2026, 9, 1, 12);
const empty = (positions = 0): AccountState => ({
  summary: {} as AccountState["summary"],
  positions: Array.from({ length: positions }, () => ({}) as AccountState["positions"][number]),
  orders: [],
});
const trade = (pnl: number, closedAt: number, id = String(closedAt)): Trade => ({
  id, positionId: id, symbol: "X", side: "LONG", entryPrice: 1, exitPrice: 1, quantity: 1, leverage: 5, margin: 10,
  realizedPnl: pnl, fees: 0, roePct: 0, openedAt: closedAt - 1, closedAt, reason: "MANUAL", signalId: null,
});

test("temiz durumda işlem serbest", () => {
  const g = computeGuard(empty(), [], cfg, "UP", NOW);
  assert.equal(g.canTrade, true);
  assert.equal(g.reasons.length, 0);
});

test("BTC günlük düşüşte → engelli", () => {
  const g = computeGuard(empty(), [], cfg, "DOWN", NOW);
  assert.equal(g.canTrade, false);
  assert.ok(g.reasons[0].includes("BTC"));
});

test("pozisyon sınırı ve günlük kayıp limiti", () => {
  assert.equal(computeGuard(empty(5), [], cfg, "UP", NOW).canTrade, false);
  const today = [trade(-1, NOW - 3_600_000, "a"), trade(-1, NOW - 1_800_000, "b")];
  const g = computeGuard(empty(), today, cfg, "UP", NOW);
  assert.equal(g.lossesToday, 2);
  assert.equal(g.canTrade, false);
  // dünkü kayıplar bugünü engellemez
  const y = [trade(-1, NOW - 30 * 3_600_000, "c"), trade(-1, NOW - 29 * 3_600_000, "d")];
  assert.equal(computeGuard(empty(), y, cfg, "UP", NOW).canTrade, true);
});

test("üst üste 4 kayıp → 3 gün mola, sonra serbest; kısmi kapatmalar tek işlem sayılır", () => {
  const D = 86_400_000;
  const losses = [5, 4, 3, 2].map((d) => trade(-1, NOW - d * D, `l${d}`));
  const g = computeGuard(empty(), losses, cfg, "UP", NOW);
  assert.ok(g.pausedUntil && g.pausedUntil > NOW);
  assert.equal(g.canTrade, false);
  const later = computeGuard(empty(), losses, cfg, "UP", NOW + 3 * D);
  assert.equal(later.pausedUntil, null);
  // Aynı pozisyonun iki kısmi kapatması: +2 ve −1 → net kâr, seriyi bozar
  const partial = [...losses.slice(0, 3), { ...trade(2, NOW - 1.5 * D, "p"), positionId: "pp" }, { ...trade(-1, NOW - 1.4 * D, "q"), positionId: "pp" }];
  assert.equal(computeGuard(empty(), partial, cfg, "UP", NOW).pausedUntil, null);
});

test("analist notu ve rapor gerçek rakamları içerir", () => {
  const sig: Signal = {
    id: "s", symbol: "ETHUSDT", interval: "1h", side: "LONG", price: 2700, candleTime: 0, createdAt: 0, strength: 80, score: 80,
    reasons: [], stopLoss: 2650, takeProfit: 2775, status: "OPEN", closedAt: null, closePrice: null, resultPct: null,
    initialStopLoss: 2650, riskReward: 1.5, label: "GÜÇLÜ AL", quality: "A+", kind: "consensus", entryLimit: 2695,
    checklist: [
      { key: "breakout", label: "Strateji: kırılım", vote: 1, weight: 1.5, detail: "Fiyat son 20 mumun zirvesini (2.690) hacimle kırdı", trigger: true },
      { key: "vwap", label: "Günlük ortalama fiyat (VWAP)", vote: -1, weight: 0.75, detail: "x" },
    ],
  };
  const note = writeSignalNote(sig, undefined, { resistance: 2740, support: 2660, adx: 31, bands: [{ label: "A+", trades: 300, wins: 192, breakevens: 60, losses: 48, expired: 0, winRatePct: 64, breakevenPct: 20, lossPct: 16, expectancyPct: 1.3, profitFactor: 1.9, sufficient: true }] });
  for (const part of ["KURULUM", "TEYİTLER (1/2)", "PLAN", "GEÇERSİZLİK", "SÜRE", "48 saat", "RİSK", "2.740", "ADX 31", "%64 kazanç • %20 başa baş • %16 kayıp"]) assert.ok(note.includes(part), `${part} eksik:\n${note}`);
  assert.ok(!note.includes("zararla kapanamaz"), "başa baş net eksidir; 'zararla kapanamaz' denmemeli");
  // Başa baş seviyesi limit girişten ölçülür: 2695 + (2695 − 2650) = 2740
  assert.ok(note.includes("Fiyat 2.740,000 seviyesine") || note.includes("Fiyat 2.740,00 seviyesine"), note);
  assert.ok(note.includes("vwap") || note.includes("Aleyhte"));

  const guard = computeGuard(empty(), [], cfg, "DOWN", NOW);
  const rep = writeMarketReport([], [sig], guard, undefined, NOW);
  assert.equal(rep.regime.label, "UYGUN DEĞİL");
  assert.ok(rep.text.includes("GÜNLÜK RAPOR"));
});
