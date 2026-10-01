import type { Candle, HistorySignal } from "@signal-lab/shared";
import { evaluateConsensus, type ConsensusInput, type ConsensusParams } from "../signals/consensus";
import { isMissed, simulate, simulateLimit, SMART_ENTRY_ATR, type BacktestOptions, type SimTrade } from "./backtest";

export interface ConsensusData {
  h1: Candle[];
  m15: Candle[];
  h4: Candle[];
  d1: Candle[];
  btc4h?: Candle[];
  btc1d?: Candle[];
}

/** Belirli bir zamana kadar kapanmış son `n` mumu, artan imleçle verimli şekilde döner. */
class Cursor {
  private end = 0;
  constructor(private readonly candles: Candle[]) {}
  upTo(time: number, n: number): Candle[] {
    while (this.end < this.candles.length && this.candles[this.end].closeTime <= time) this.end++;
    return this.candles.slice(Math.max(0, this.end - n), this.end);
  }
}

/** Kaçırılan (dolmayan) akıllı giriş emirleri ve isteğe bağlı grafik geçmişi */
export interface MissedCounter {
  missed: number;
  /** Doluysa her sinyal (kaçırılanlar dahil) grafik için buraya eklenir */
  history?: HistorySignal[];
  symbol?: string;
}

export interface ConsensusRunOptions {
  /** A+ sinyallerde akıllı giriş (sinyal − 0.25 ATR limit); A sinyaller hemen (market) */
  smartEntry?: boolean;
  /** Sadece bu zamandan sonra açılan sinyalleri değerlendir (öncesi ısınma) */
  from?: number;
}

/**
 * Konsensüs sinyalini 1s mumlar üzerinde adım adım test eder. Her adımda 15dk/4s/1G verilerinin
 * sadece o ana kadar kapanmış mumları kullanılır (lookahead yok).
 *
 * Pozisyon kuralları (canlı sistemle aynı):
 *  - Aynı coinde açık işlem (ya da bekleyen akıllı giriş emri) varken yeni sinyal açılmaz.
 *  - Cooldown, işlem KAPANDIKTAN (ya da emir kaçtıktan) sonra sayılır.
 */
export function* consensusSteps(
  data: ConsensusData,
  params: ConsensusParams,
  opts: BacktestOptions,
  out: SimTrade[],
  run: ConsensusRunOptions = {},
  counter: MissedCounter = { missed: 0 },
): Generator<void, SimTrade[]> {
  const btc = data.btc4h ? new Cursor(data.btc4h) : null;
  const btcD = data.btc1d ? new Cursor(data.btc1d) : null;
  const m15 = new Cursor(data.m15);
  const h4 = new Cursor(data.h4);
  const d1 = new Cursor(data.d1);
  let nextAllowed = 0;

  for (let i = 210; i < data.h1.length - 1; i++) {
    yield;
    if (i < nextAllowed) continue;
    const t = data.h1[i].closeTime;
    if (run.from && data.h1[i].openTime < run.from) {
      // ısınma: imleçleri ilerlet ama işlem açma
      m15.upTo(t, 0);
      h4.upTo(t, 0);
      d1.upTo(t, 0);
      continue;
    }
    const input: ConsensusInput = {
      h1: data.h1.slice(Math.max(0, i - opts.window + 1), i + 1),
      m15: m15.upTo(t, 200),
      h4: h4.upTo(t, 300),
      d1: d1.upTo(t, 400),
      btc4h: btc ? btc.upTo(t, 300) : undefined,
      btc1d: btcD ? btcD.upTo(t, 300) : undefined,
    };
    const sig = evaluateConsensus(input, params).signal;
    if (!sig) continue;

    const record = (r: Omit<SimTrade, "confidence"> | null, missedAt?: number) => {
      if (!counter.history) return;
      const missed = missedAt !== undefined;
      counter.history.push({
        symbol: counter.symbol ?? "",
        side: sig.side,
        candleTime: data.h1[i].openTime,
        entryTime: missed ? data.h1[i].closeTime + 1 : (r!.entryTime ?? data.h1[i].closeTime + 1),
        entry: missed ? data.h1[i].close : r!.entry,
        stopLoss: sig.stopLoss,
        takeProfit: sig.takeProfit,
        quality: sig.quality,
        outcome: missed ? "MISSED" : r!.outcome,
        exit: missed ? null : r!.exit,
        exitTime: missed ? data.h1[missedAt].closeTime : r!.exitTime,
        netPct: missed ? null : r!.netPct,
      });
    };

    if (run.smartEntry && sig.quality === "A+") {
      const limit = data.h1[i].close - (sig.side === "LONG" ? 1 : -1) * SMART_ENTRY_ATR * sig.atr;
      const r = simulateLimit(data.h1, i, sig.side, limit, sig.stopLoss, sig.takeProfit, opts);
      if (!r) break; // veri bitti, işlem henüz sonuçlanmadı
      if (isMissed(r)) {
        counter.missed++;
        record(null, r.at);
        nextAllowed = r.at + opts.cooldownCandles;
        continue;
      }
      record(r);
      out.push({ ...r, confidence: 1 });
      nextAllowed = r.exitIndex + opts.cooldownCandles;
      continue;
    }
    const r = simulate(data.h1, i, sig.side, sig.stopLoss, sig.takeProfit, opts);
    if (!r) break;
    record(r);
    out.push({ ...r, confidence: sig.strong ? 1 : 0 });
    nextAllowed = r.exitIndex + opts.cooldownCandles;
  }
  return out;
}

export function backtestConsensus(
  data: ConsensusData,
  params: ConsensusParams,
  opts: BacktestOptions,
  run: ConsensusRunOptions = {},
  counter: MissedCounter = { missed: 0 },
): SimTrade[] {
  const out: SimTrade[] = [];
  const it = consensusSteps(data, params, opts, out, run, counter);
  while (!it.next().done);
  return out;
}

export async function backtestConsensusAsync(
  data: ConsensusData,
  params: ConsensusParams,
  opts: BacktestOptions,
  run: ConsensusRunOptions = {},
  counter: MissedCounter = { missed: 0 },
): Promise<SimTrade[]> {
  const out: SimTrade[] = [];
  const it = consensusSteps(data, params, opts, out, run, counter);
  let n = 0;
  while (!it.next().done) if (++n % 30 === 0) await new Promise((r) => setImmediate(r));
  return out;
}
