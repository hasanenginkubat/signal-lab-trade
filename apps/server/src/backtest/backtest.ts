import { MIN_TRADES_FOR_STATS, type Candle, type Interval, type PositionSide, type TrackRecord } from "@signal-lab/shared";
import { evaluate, type StrategyParams } from "../signals/strategy";

/** Sinyal aralığı → trend onayı için bakılan üst zaman dilimi */
export const HIGHER_TIMEFRAME: Record<Interval, Interval | null> = {
  "1m": "5m",
  "5m": "15m",
  "15m": "1h",
  "1h": "4h",
  "4h": "1d",
  "1d": null,
};

export interface BacktestOptions {
  /** TP/SL'ye değmeyen sinyalin kapanacağı mum sayısı */
  expiryCandles: number;
  /** Pozisyon KAPANDIKTAN sonra aynı coinde yeni sinyal için beklenecek mum */
  cooldownCandles: number;
  /** Gidiş-dönüş toplam maliyet (%): 2 × (taker ücreti + kayma) */
  roundTripFeePct: number;
  /** Her adımda stratejiye verilen geçmiş mum sayısı (canlı motorla aynı) */
  window: number;
  /** Fiyat bu kadar R ilerleyince stop GİRİŞE çekilir; 0 = kapalı */
  breakevenAtR: number;
}

/** Varsayılan maliyet: taker %0.05 + kayma %0.02, giriş ve çıkışta → %0.14 */
export function roundTripCostPct(costs: { takerFeePct: number; slippagePct: number }): number {
  return 2 * (costs.takerFeePct + costs.slippagePct);
}

export const DEFAULT_BACKTEST_OPTIONS: BacktestOptions = {
  expiryCandles: 48,
  cooldownCandles: 6,
  roundTripFeePct: roundTripCostPct({ takerFeePct: 0.05, slippagePct: 0.02 }),
  window: 400,
  breakevenAtR: 1,
};

/**
 * Başa baş stop: tam GİRİŞ fiyatı. Ücret ve kayma nedeniyle başa baş çıkış net olarak hafif eksidir
 * (önceden girişin 0.15R üstüne konuyordu; bu, "başa baş" işlemleri kâr gibi gösteriyordu).
 */
export const BREAKEVEN_OFFSET_R = 0;

/** Akıllı giriş: sinyal kapanışının bu kadar ATR altına limit emir */
export const SMART_ENTRY_ATR = 0.25;
/** Akıllı giriş emrinin geçerli olduğu mum (saat) sayısı */
export const SMART_ENTRY_CANDLES = 6;

export type Outcome = "TP" | "SL" | "BE" | "EXPIRED";

export interface SimTrade {
  side: PositionSide;
  /** Girişten sonraki ilk mumdan önceki mum indeksi (market: sinyal mumu, akıllı: dolum mumu) */
  index: number;
  /** Sinyal mumunun açılış zamanı */
  time: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exit: number;
  outcome: Outcome;
  /** Ücret + kayma düşülmüş net getiri (%) */
  netPct: number;
  confidence: number;
  /** Çıkış mumunun indeksi ve kapanış zamanı */
  exitIndex: number;
  exitTime: number;
  /** Giriş zamanı (market: sinyal kapanışı, akıllı: dolum mumunun açılışı) */
  entryTime: number;
}

export type SimResult = Omit<SimTrade, "confidence">;

/**
 * Tek işlemin sonucu. Kötümser kurallar:
 *  - Aynı mumda hem stop hem hedef görülürse → STOP.
 *  - Aynı mumda hem 1R (başa baş tetiği) hem stop görülürse → STOP (stop, mum KAPANDIKTAN sonra taşınır).
 * Veri sonuna kadar sonuçlanmayan işlem null döner (henüz açık).
 */
export function simulate(
  candles: Candle[],
  i: number,
  side: PositionSide,
  stopLoss: number,
  takeProfit: number,
  opts: BacktestOptions,
  /** Giriş fiyatı (varsayılan: i. mumun kapanışı) */
  entryPrice?: number,
): SimResult | null {
  const entry = entryPrice ?? candles[i].close;
  const long = side === "LONG";
  const dir = long ? 1 : -1;
  const risk = Math.abs(entry - stopLoss);
  const last = Math.min(candles.length - 1, i + opts.expiryCandles);
  let stop = stopLoss;
  let moved = false;
  let exit = NaN;
  let exitIndex = last;
  let outcome: Outcome = "EXPIRED";

  for (let j = i + 1; j <= last; j++) {
    const c = candles[j];
    if (long ? c.low <= stop : c.high >= stop) {
      exit = stop;
      exitIndex = j;
      outcome = moved ? "BE" : "SL";
      break;
    }
    if (long ? c.high >= takeProfit : c.low <= takeProfit) {
      exit = takeProfit;
      exitIndex = j;
      outcome = "TP";
      break;
    }
    if (!moved && opts.breakevenAtR > 0 && (long ? c.high >= entry + opts.breakevenAtR * risk : c.low <= entry - opts.breakevenAtR * risk)) {
      stop = entry + dir * BREAKEVEN_OFFSET_R * risk;
      moved = true;
    }
  }
  if (outcome === "EXPIRED") {
    if (last < i + opts.expiryCandles) return null;
    exit = candles[last].close;
  }
  const grossPct = ((exit - entry) / entry) * 100 * dir;
  return {
    side,
    index: i,
    time: candles[i].openTime,
    entry,
    stopLoss,
    takeProfit,
    exit,
    outcome,
    netPct: grossPct - opts.roundTripFeePct,
    exitIndex,
    exitTime: candles[exitIndex].closeTime,
    entryTime: candles[i].closeTime + 1,
  };
}

/** Akıllı giriş dolmadı: hangi mumda fırsat kaçtı */
export interface Missed {
  missed: true;
  /** Fırsatın kaçtığı mum (hedefe gitti ya da süre doldu) */
  at: number;
}

/**
 * Akıllı giriş: `limit` fiyatına emir; `validCandles` içinde dolmazsa ya da fiyat dolmadan hedefe
 * kaçarsa işlem yok. Dolduğu mumda stop da görülürse kötümser şekilde STOP sayılır.
 */
export function simulateLimit(
  candles: Candle[],
  i: number,
  side: PositionSide,
  limit: number,
  stopLoss: number,
  takeProfit: number,
  opts: BacktestOptions,
  validCandles = SMART_ENTRY_CANDLES,
): SimResult | Missed | null {
  const long = side === "LONG";
  let filled = -1;
  const lastJ = Math.min(candles.length - 1, i + validCandles);
  for (let j = i + 1; j <= lastJ; j++) {
    if (long ? candles[j].high >= takeProfit : candles[j].low <= takeProfit) return { missed: true, at: j };
    if (long ? candles[j].low <= limit : candles[j].high >= limit) {
      filled = j;
      break;
    }
  }
  if (filled < 0) return i + validCandles < candles.length ? { missed: true, at: i + validCandles } : null;
  if (long ? candles[filled].low <= stopLoss : candles[filled].high >= stopLoss) {
    const net = ((stopLoss - limit) / limit) * 100 * (long ? 1 : -1) - opts.roundTripFeePct;
    return {
      side,
      index: filled,
      time: candles[i].openTime,
      entry: limit,
      stopLoss,
      takeProfit,
      exit: stopLoss,
      outcome: "SL",
      netPct: net,
      exitIndex: filled,
      exitTime: candles[filled].closeTime,
      entryTime: candles[filled].openTime,
    };
  }
  const t = simulate(candles, filled, side, stopLoss, takeProfit, opts, limit);
  return t ? { ...t, time: candles[i].openTime, entryTime: candles[filled].openTime } : null;
}

export function isMissed(r: SimResult | Missed | null): r is Missed {
  return !!r && (r as Missed).missed === true;
}

/**
 * Eski tek-strateji backtest'i (karşılaştırma CLI'ı için). Aynı coinde açık işlem varken yeni
 * sinyal açılmaz; cooldown pozisyon kapanışından sayılır.
 */
export function* backtestSteps(
  candles: Candle[],
  higher: Candle[] | null,
  params: StrategyParams,
  opts: BacktestOptions,
  out: SimTrade[],
): Generator<void, SimTrade[]> {
  let nextAllowed = 0;
  let hiEnd = 0;
  for (let i = 210; i < candles.length - 1; i++) {
    yield;
    if (i < nextAllowed) continue;
    const window = candles.slice(Math.max(0, i - opts.window + 1), i + 1);
    let hiSlice: Candle[] | undefined;
    if (higher) {
      while (hiEnd < higher.length && higher[hiEnd].closeTime <= candles[i].closeTime) hiEnd++;
      hiSlice = higher.slice(Math.max(0, hiEnd - 300), hiEnd);
    }
    const sig = evaluate(window, params, hiSlice).signal;
    if (!sig) continue;
    const trade = simulate(candles, i, sig.side, sig.stopLoss, sig.takeProfit, opts);
    if (!trade) break;
    out.push({ ...trade, confidence: sig.confidence });
    nextAllowed = trade.exitIndex + opts.cooldownCandles;
  }
  return out;
}

export function backtest(
  candles: Candle[],
  higher: Candle[] | null,
  params: StrategyParams,
  opts: BacktestOptions = DEFAULT_BACKTEST_OPTIONS,
): SimTrade[] {
  const out: SimTrade[] = [];
  const it = backtestSteps(candles, higher, params, opts, out);
  while (!it.next().done);
  return out;
}

export interface Stats extends TrackRecord {
  avgWinPct: number;
  avgLossPct: number;
}

/**
 * Karne. Kazanç YALNIZCA hedefe (TP) ulaşan işlemdir; başa baş ve kayıp ayrı sayılır.
 * Profit factor: net pozitif işlemlerin toplamı / net negatiflerin toplamı.
 */
export function stats(trades: Pick<SimTrade, "outcome" | "netPct">[]): Stats {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "TP").length;
  const breakevens = trades.filter((t) => t.outcome === "BE").length;
  const losses = trades.filter((t) => t.outcome === "SL").length;
  const expired = trades.filter((t) => t.outcome === "EXPIRED").length;
  const pos = trades.filter((t) => t.netPct > 0);
  const neg = trades.filter((t) => t.netPct <= 0);
  const grossWin = pos.reduce((a, t) => a + t.netPct, 0);
  const grossLoss = -neg.reduce((a, t) => a + t.netPct, 0);
  const pct = (x: number) => (n ? (x / n) * 100 : 0);
  return {
    trades: n,
    wins,
    breakevens,
    losses,
    expired,
    winRatePct: pct(wins),
    breakevenPct: pct(breakevens),
    lossPct: pct(losses),
    expectancyPct: n ? (grossWin - grossLoss) / n : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    sufficient: n >= MIN_TRADES_FOR_STATS,
    avgWinPct: pos.length ? grossWin / pos.length : 0,
    avgLossPct: neg.length ? -grossLoss / neg.length : 0,
  };
}

/**
 * Bileşik equity eğrisi: her işlemde bakiyenin `riskPct`'i riske edilir (stop olursa −riskPct).
 * İşlem sonucu R cinsinden: net% / stop mesafesi%. İşlemler kapanış zamanına göre işlenir.
 */
export function equityCurve(
  trades: Pick<SimTrade, "entry" | "stopLoss" | "netPct" | "exitTime">[],
  riskPct = 1,
): { maxDrawdownPct: number; returnPct: number } {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    const stopDistPct = (Math.abs(t.entry - t.stopLoss) / t.entry) * 100;
    if (!(stopDistPct > 0)) continue;
    const r = t.netPct / stopDistPct;
    equity *= 1 + (riskPct / 100) * r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  }
  return { maxDrawdownPct: maxDd, returnPct: (equity - 1) * 100 };
}

/** Al-tut: dönem başında alıp sonunda satmanın getirisi (%) */
export function buyHoldPct(candles: Candle[], from: number, to: number): number | null {
  const inRange = candles.filter((c) => c.openTime >= from && c.closeTime <= to);
  if (inRange.length < 2) return null;
  return ((inRange[inRange.length - 1].close - inRange[0].open) / inRange[0].open) * 100;
}
