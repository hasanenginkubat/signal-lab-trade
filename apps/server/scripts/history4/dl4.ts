/** 4 dönem için Binance USDT-M 1d/4h/1h/15m verisini diske önbellekler. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle, Interval } from "@signal-lab/shared";
import { fetchKlines } from "../../src/binance/rest";

const DIR = process.env.DIR!;
const DAY = 86_400_000;
export const PERIODS = [
  { key: "bull21", from: Date.UTC(2021, 0, 1), to: Date.UTC(2021, 10, 10) },
  { key: "bear22", from: Date.UTC(2021, 10, 10), to: Date.UTC(2023, 0, 1) },
  { key: "flat23", from: Date.UTC(2023, 0, 1), to: Date.UTC(2024, 0, 1) },
  { key: "etf24", from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 0, 1) },
];
const A = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "LINK", "LTC", "DOT", "AVAX", "BCH", "TRX", "XLM", "ETC", "ATOM", "FIL", "UNI", "AAVE", "NEAR"].map((s) => s + "USDT");
const B: string[] = JSON.parse(readFileSync(join(DIR, "universeB.json"), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchAll(symbol: string, interval: Interval, from: number, to: number): Promise<Candle[]> {
  let out: Candle[] = [];
  let end = to - 1;
  for (let page = 0; page < 200; page++) {
    let batch: Candle[] = [];
    for (let attempt = 0; ; attempt++) {
      try { batch = await fetchKlines(symbol, interval, 1500, end); break; } catch (e) {
        if (attempt > 5) throw e;
        await sleep(5000 * (attempt + 1));
      }
    }
    await sleep(300);
    const older = batch.filter((c) => c.openTime < (out[0]?.openTime ?? Infinity) && c.openTime >= from);
    out = [...older, ...out];
    if (!batch.length || batch[0].openTime <= from || older.length === 0) break;
    end = batch[0].openTime - 1;
  }
  return out.filter((c) => c.closeTime < to);
}

async function cached(file: string, get: () => Promise<Candle[]>): Promise<Candle[]> {
  const p = join(DIR, file);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  const c = await get();
  writeFileSync(p, JSON.stringify(c.map((x) => [x.openTime, x.open, x.high, x.low, x.close, x.volume])));
  return c;
}

async function main() {
  const symbols = [...new Set([...A, ...B])];
  const listing: Record<string, number | null> = {};
  for (const s of symbols) {
    const d1 = await cached(`${s}_1d.json`, () => fetchAll(s, "1d", Date.UTC(2019, 8, 1), Date.UTC(2025, 0, 1)));
    const first = (d1[0] as any)?.[0] ?? (d1[0] as any)?.openTime ?? null;
    listing[s] = first;
  }
  writeFileSync(join(DIR, "listing.json"), JSON.stringify(listing));
  for (const p of PERIODS) {
    for (const s of symbols) {
      const l = listing[s];
      if (l == null || l > p.from) continue; // dönem başında futures verisi yok
      for (const iv of ["1h", "4h", "15m"] as Interval[]) {
        const warm = iv === "4h" ? 60 * DAY : iv === "1h" ? 30 * DAY : 4 * DAY;
        await cached(`${s}_${p.key}_${iv}.json`, () => fetchAll(s, iv, p.from - warm, p.to));
      }
      console.log(p.key, s, new Date().toISOString());
    }
  }
  console.log("DONE");
}
if (process.argv[2] === "run") main();
