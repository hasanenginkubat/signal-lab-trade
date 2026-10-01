/** Bir dönem için A/B evreni × A+/Tümü sonuçları (mevcut motor + ölçüm kuralları, rejim filtresi yok). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INTERVAL_MS, type Candle, type Interval } from "@signal-lab/shared";
import { config } from "../../src/config";
import { consensusParamsFrom, evaluateConsensus } from "../../src/signals/consensus";
import { DEFAULT_BACKTEST_OPTIONS as OPTS, isMissed, simulate, simulateLimit, SMART_ENTRY_ATR } from "../../src/backtest/backtest";

const DIR = process.env.DIR!;
const key = process.argv[2];
const PERIODS: Record<string, [number, number]> = {
  bull21: [Date.UTC(2021, 0, 1), Date.UTC(2021, 10, 10)],
  bear22: [Date.UTC(2021, 10, 10), Date.UTC(2023, 0, 1)],
  flat23: [Date.UTC(2023, 0, 1), Date.UTC(2024, 0, 1)],
  etf24: [Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1)],
};
const [FROM, TO] = PERIODS[key];
const A = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "LINK", "LTC", "DOT", "AVAX", "BCH", "TRX", "XLM", "ETC", "ATOM", "FIL", "UNI", "AAVE", "NEAR"].map((s) => s + "USDT");
const B: string[] = JSON.parse(readFileSync(join(DIR, "universeB.json"), "utf8"));
const params = consensusParamsFrom(config);

function load(symbol: string, iv: Interval, file: string): Candle[] {
  const p = join(DIR, file);
  if (!existsSync(p)) return [];
  const ms = INTERVAL_MS[iv];
  return (JSON.parse(readFileSync(p, "utf8")) as number[][]).map(([o, op, h, l, c, v]) => ({ symbol, interval: iv, openTime: o, closeTime: o + ms - 1, open: op, high: h, low: l, close: c, volume: v, isClosed: true }));
}
class Cursor { e = 0; constructor(private c: Candle[]) {} upTo(t: number, n: number) { while (this.e < this.c.length && this.c[this.e].closeTime <= t) this.e++; return this.c.slice(Math.max(0, this.e - n), this.e); } }

const listing: Record<string, number | null> = JSON.parse(readFileSync(join(DIR, "listing.json"), "utf8"));
const has = (s: string) => listing[s] != null && listing[s]! <= FROM && existsSync(join(DIR, `${s}_${key}_1h.json`));
const symbols = [...new Set([...A, ...B])].filter(has);
const btc4h = load("BTCUSDT", "4h", `BTCUSDT_${key}_4h.json`);
const btc1d = load("BTCUSDT", "1d", "BTCUSDT_1d.json");

type T = { symbol: string; quality: string; entry: number; stopLoss: number; netPct: number; exitTime: number; outcome: string };
const trades: Record<string, { aplus: T[]; all: T[]; missed: { aplus: number; all: number } }> = {};
const hold: Record<string, { start: number; closes: [number, number][] }> = {};
for (const s of symbols) {
  const h1 = load(s, "1h", `${s}_${key}_1h.json`);
  const m15 = new Cursor(load(s, "15m", `${s}_${key}_15m.json`));
  const h4 = new Cursor(load(s, "4h", `${s}_${key}_4h.json`));
  const d1 = new Cursor(load(s, "1d", `${s}_1d.json`));
  const b4 = new Cursor(btc4h), bd = new Cursor(btc1d);
  const inP = h1.filter((c) => c.openTime >= FROM);
  if (inP.length) hold[s] = { start: inP[0].open, closes: inP.map((c) => [c.closeTime + 1, c.close]) };
  const sigs: { i: number; sig: NonNullable<ReturnType<typeof evaluateConsensus>["signal"]> }[] = [];
  for (let i = 210; i < h1.length - 1; i++) {
    const t = h1[i].closeTime;
    const input = { h1: h1.slice(Math.max(0, i - OPTS.window + 1), i + 1), m15: m15.upTo(t, 200), h4: h4.upTo(t, 300), d1: d1.upTo(t, 400), btc4h: b4.upTo(t, 300), btc1d: bd.upTo(t, 300) };
    if (h1[i].openTime < FROM) continue;
    const sig = evaluateConsensus(input, params).signal;
    if (sig) sigs.push({ i, sig });
  }
  const res = { aplus: [] as T[], all: [] as T[], missed: { aplus: 0, all: 0 } };
  for (const set of ["aplus", "all"] as const) {
    let next = 0;
    for (const { i, sig } of sigs) {
      if (i < next) continue;
      if (set === "aplus" && sig.quality !== "A+") continue;
      let r;
      if (sig.quality === "A+") {
        const limit = h1[i].close - (sig.side === "LONG" ? 1 : -1) * SMART_ENTRY_ATR * sig.atr;
        r = simulateLimit(h1, i, sig.side, limit, sig.stopLoss, sig.takeProfit, OPTS);
        if (!r) break;
        if (isMissed(r)) { res.missed[set]++; next = r.at + OPTS.cooldownCandles; continue; }
      } else {
        r = simulate(h1, i, sig.side, sig.stopLoss, sig.takeProfit, OPTS);
        if (!r) break;
      }
      res[set].push({ symbol: s, quality: sig.quality, entry: r.entry, stopLoss: r.stopLoss, netPct: r.netPct, exitTime: r.exitTime, outcome: r.outcome });
      next = r.exitIndex + OPTS.cooldownCandles;
    }
  }
  trades[s] = res;
  process.stderr.write(`${s} `);
}
const excludedA = A.filter((s) => !symbols.includes(s));
const excludedB = B.filter((s) => !symbols.includes(s));
writeFileSync(join(DIR, `res_${key}.json`), JSON.stringify({ key, from: FROM, to: TO, symbols, excludedA, excludedB, trades, hold }));
console.log("\nok", key, symbols.length);
