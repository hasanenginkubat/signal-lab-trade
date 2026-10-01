import type { Candle, Interval, Ticker } from "@signal-lab/shared";
import { config } from "../config";
import { rowToCandle, ticker24hToTicker } from "./mapper";
import type { BinanceKlineRow, BinanceTicker24h } from "./types";

async function getJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const url = `${config.marketRestBase}${path}?${qs}`;
  let res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  // İstek limiti aşılırsa (429/418) Binance'in istediği kadar bekleyip bir kez daha dene
  if (res.status === 429 || res.status === 418) {
    const wait = Math.min(60, Number(res.headers.get("retry-after") ?? 10)) * 1000;
    console.warn(`[binance] istek limiti, ${wait / 1000}sn bekleniyor`);
    await new Promise((r) => setTimeout(r, wait));
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function fetchKlines(
  symbol: string,
  interval: Interval,
  limit = 500,
  endTime?: number,
): Promise<Candle[]> {
  const rows = await getJson<BinanceKlineRow[]>("/fapi/v1/klines", {
    symbol,
    interval,
    limit: Math.min(Math.max(limit, 1), 1500),
    endTime,
  });
  const now = Date.now();
  return rows.map((row) => rowToCandle(symbol, interval, row, now));
}

export async function fetchTickers(symbols: string[]): Promise<Ticker[]> {
  const all = await getJson<BinanceTicker24h[]>("/fapi/v1/ticker/24hr", {});
  const wanted = new Set(symbols);
  return all.filter((t) => wanted.has(t.symbol)).map(ticker24hToTicker);
}

/** Bir emrin Binance'te kabul edilmesi için gereken en küçük büyüklük (USDT) */
export function minOrderUsd(f: SymbolFilters, price: number): number {
  return Math.max(f.minNotional, f.minQty * price);
}

export interface SymbolFilters {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
}

interface ExchangeInfo {
  symbols: {
    symbol: string;
    status: string;
    pricePrecision: number;
    quantityPrecision: number;
    filters: { filterType: string; [k: string]: string | number }[];
  }[];
}

export async function fetchSymbolFilters(symbols: string[]): Promise<Map<string, SymbolFilters>> {
  const info = await getJson<ExchangeInfo>("/fapi/v1/exchangeInfo", {});
  const wanted = new Set(symbols);
  const out = new Map<string, SymbolFilters>();
  for (const s of info.symbols) {
    if (!wanted.has(s.symbol)) continue;
    const find = (type: string) => s.filters.find((f) => f.filterType === type);
    const price = find("PRICE_FILTER");
    const lot = find("MARKET_LOT_SIZE") ?? find("LOT_SIZE");
    const notional = find("MIN_NOTIONAL");
    out.set(s.symbol, {
      symbol: s.symbol,
      tickSize: Number(price?.tickSize ?? 0.01),
      stepSize: Number(lot?.stepSize ?? 0.001),
      minQty: Number(lot?.minQty ?? 0),
      minNotional: Number(notional?.notional ?? 5),
      pricePrecision: s.pricePrecision,
      quantityPrecision: s.quantityPrecision,
    });
  }
  return out;
}

interface UniverseExchangeInfo {
  symbols: {
    symbol: string;
    status: string;
    contractType: string;
    underlyingType?: string;
    quoteAsset: string;
    baseAsset: string;
    onboardDate: number;
  }[];
}

/** Stabil coinler ve altına bağlı tokenlar: kripto gibi hareket etmez */
const STABLE_BASES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "USDP", "DAI", "USDE", "EUR", "USD1", "XUSD", "PAXG", "XAUT"]);
/** Her zaman listede olan ana coinler */
const CORE = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

export interface UniverseOptions {
  size: number;
  minQuoteVolume: number;
  minAgeDays: number;
}

/**
 * Gün içi trade için coin evreni: sadece kripto (COIN) perpetual kontratlar; hisse, emtia
 * ve yeni listelenmiş coinler hariç. Hacim (likidite) ve günlük hareket (fırsat) birlikte
 * puanlanır; günde %40'tan fazla oynayan pompa coinleri cezalandırılır.
 */
export async function selectUniverse(opts: UniverseOptions): Promise<string[]> {
  const [info, tickers] = await Promise.all([
    getJson<UniverseExchangeInfo>("/fapi/v1/exchangeInfo", {}),
    getJson<BinanceTicker24h[]>("/fapi/v1/ticker/24hr", {}),
  ]);
  const minOnboard = Date.now() - opts.minAgeDays * 86_400_000;
  const eligible = new Set(
    info.symbols
      .filter(
        (s) =>
          s.status === "TRADING" &&
          s.contractType === "PERPETUAL" &&
          (s.underlyingType ?? "COIN") === "COIN" &&
          s.quoteAsset === "USDT" &&
          !STABLE_BASES.has(s.baseAsset) &&
          s.onboardDate < minOnboard,
      )
      .map((s) => s.symbol),
  );

  const scored = tickers
    .filter((t) => eligible.has(t.symbol) && Number(t.quoteVolume) >= opts.minQuoteVolume)
    .map((t) => {
      const high = Number(t.highPrice);
      const low = Number(t.lowPrice);
      const range = low > 0 ? ((high - low) / low) * 100 : 0;
      const volume = Number(t.quoteVolume);
      // Hacim: log ölçek (100M → 0, 10B → 1); hareket: %3-%15 ideal, %40 üstü pompa
      const volScore = Math.min(1, Math.max(0, (Math.log10(volume) - 8) / 2));
      const rangeScore = range < 3 ? range / 3 : range <= 15 ? 1 : range <= 40 ? 1 - (range - 15) / 50 : 0;
      return { symbol: t.symbol, score: volScore * 0.6 + rangeScore * 0.4, range };
    })
    .filter((s) => s.range <= 60)
    .sort((a, b) => b.score - a.score);

  const picked = new Set(CORE.filter((s) => eligible.has(s)));
  for (const s of scored) {
    if (picked.size >= opts.size) break;
    picked.add(s.symbol);
  }
  return [...picked];
}

/** [from, to) aralığındaki tüm mumlar (geriye doğru sayfalayarak; istek limitine saygılı) */
export async function fetchRange(symbol: string, interval: Interval, from: number, to: number, pauseMs = 250): Promise<Candle[]> {
  let out: Candle[] = [];
  let end = to - 1;
  for (let page = 0; page < 12; page++) {
    const batch = await fetchKlines(symbol, interval, 1500, end);
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    const older = batch.filter((c) => c.openTime < (out[0]?.openTime ?? Infinity));
    out = [...older, ...out];
    if (!batch.length || batch[0].openTime <= from) break;
    end = batch[0].openTime - 1;
  }
  return out.filter((c) => c.openTime >= from && c.closeTime < to && c.isClosed);
}
