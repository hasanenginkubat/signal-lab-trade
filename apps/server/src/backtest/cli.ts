/**
 * Strateji varyantlarını gerçek Binance geçmiş verisinde karşılaştırır.
 *   npm run backtest -w @signal-lab/server
 * Veri bir kez indirilip ./data/backtest-cache.json içine kaydedilir (tekrar çalıştırmada hızlı).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle, Interval } from "@signal-lab/shared";
import { fetchKlines, selectUniverse } from "../binance/rest";
import { config } from "../config";
import { DEFAULT_PARAMS, type StrategyParams } from "../signals/strategy";
import { backtest, DEFAULT_BACKTEST_OPTIONS, HIGHER_TIMEFRAME, stats, type SimTrade } from "./backtest";

const INTERVALS: Interval[] = ["15m", "1h", "4h"];
// 4h: sadece karşılaştırma için (varsayılan sinyal aralıkları 15m ve 1h)
const cacheFile = join(config.dataDir, "backtest-cache.json");

async function loadData(): Promise<Record<string, Candle[]>> {
  if (existsSync(cacheFile) && !process.argv.includes("--refresh")) {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  }
  const symbols = config.symbols ?? (await selectUniverse(config.universe));
  console.log(`Veri indiriliyor: ${symbols.length} coin…`);
  const data: Record<string, Candle[]> = {};
  const needed = new Set<Interval>();
  for (const iv of INTERVALS) {
    needed.add(iv);
    const h = HIGHER_TIMEFRAME[iv];
    if (h) needed.add(h);
  }
  for (const s of symbols) {
    for (const iv of needed) {
      data[`${s}:${iv}`] = (await fetchKlines(s, iv, 1500)).filter((c) => c.isClosed);
    }
    process.stdout.write(".");
  }
  console.log();
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(data));
  return data;
}

const NO_BE = { ...DEFAULT_BACKTEST_OPTIONS, breakevenAtR: 0 };
const variants: { name: string; params: StrategyParams; opts?: typeof NO_BE }[] = [
  { name: "v1 (eski, filtresiz, L+S)", params: { ...DEFAULT_PARAMS, minAdx: 0, requireHigherTimeframe: false, riskReward: 2, allowShort: true }, opts: NO_BE },
  { name: "v2 L+S, BE yok", params: { ...DEFAULT_PARAMS, allowShort: true }, opts: NO_BE },
  { name: "v2 sadece long, BE yok", params: DEFAULT_PARAMS, opts: NO_BE },
  { name: "v2 VARSAYILAN (long, RR1.5, BE@1R)", params: DEFAULT_PARAMS },
  { name: "v2 long, RR1, BE@0.7R", params: { ...DEFAULT_PARAMS, riskReward: 1 }, opts: { ...DEFAULT_BACKTEST_OPTIONS, breakevenAtR: 0.7 } },
  { name: "v2 long, RR2, BE@1R", params: { ...DEFAULT_PARAMS, riskReward: 2 } },
];

function fmt(name: string, trades: SimTrade[]) {
  const s = stats(trades);
  const half = Math.floor(trades.length / 2);
  const sorted = [...trades].sort((a, b) => a.time - b.time);
  const a = stats(sorted.slice(0, half));
  const b = stats(sorted.slice(half));
  return `${name.padEnd(34)} işlem=${String(s.trades).padStart(4)}  isabet=%${s.winRatePct.toFixed(1).padStart(5)}  net/işlem=${s.expectancyPct.toFixed(3).padStart(7)}%  PF=${s.profitFactor.toFixed(2)}  | 1.yarı %${a.winRatePct.toFixed(0)} ${a.expectancyPct.toFixed(2)}%  2.yarı %${b.winRatePct.toFixed(0)} ${b.expectancyPct.toFixed(2)}%`;
}

const data = await loadData();
const symbols = [...new Set(Object.keys(data).map((k) => k.split(":")[0]))];
console.log(`${symbols.length} coin, aralıklar: ${INTERVALS.join(", ")}; ücret: %0.1 gidiş-dönüş\n`);

for (const iv of [...INTERVALS, "TÜMÜ" as const]) {
  console.log(`=== ${iv} ===`);
  for (const v of variants) {
    const all: SimTrade[] = [];
    for (const s of symbols) {
      for (const interval of iv === "TÜMÜ" ? INTERVALS : [iv]) {
        const candles = data[`${s}:${interval}`];
        const h = HIGHER_TIMEFRAME[interval];
        if (!candles) continue;
        all.push(...backtest(candles, h ? data[`${s}:${h}`] : null, v.params, v.opts));
      }
    }
    console.log(fmt(v.name, all));
  }
  console.log();
}
