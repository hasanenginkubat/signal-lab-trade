import { createHash } from "node:crypto";
import type {
  BacktestBand,
  BacktestResult,
  BacktestSummary,
  Candle,
  HistorySignal,
  Interval,
  PeriodReport,
  SignalQuality,
  TrackRecord,
} from "@signal-lab/shared";
import { fetchRange } from "../binance/rest";
import type { Config } from "../config";
import { JsonStore } from "../db/jsonStore";
import type { MarketData } from "../market/marketData";
import { consensusParamsFrom } from "../signals/consensus";
import { buyHoldPct, DEFAULT_BACKTEST_OPTIONS, equityCurve, roundTripCostPct, stats, type BacktestOptions, type SimTrade } from "./backtest";
import { backtestConsensusAsync, type ConsensusData, type MissedCounter } from "./consensusBacktest";

const RERUN_MS = 6 * 60 * 60_000;
const DAY = 86_400_000;
/** Kod mantığı değişince artırılır (önbelleği geçersiz kılar) */
const LOGIC_VERSION = "legacy-logic-v1";
const INTERVAL: Interval = "1h";

interface PeriodData {
  report: PeriodReport | null;
  bands: BacktestBand[];
  results: BacktestResult[];
}

interface Persisted {
  version: string;
  updatedAt: number | null;
  oos: PeriodData | null;
  inSample: PeriodData | null;
  history: Record<string, HistorySignal[]>;
}

export interface WinEstimate {
  /** A+ / A seviyesinin örneklem dışı karnesi (n < 30 ise yetersiz) */
  record: TrackRecord | null;
}

/**
 * İki dönemde backtest:
 *  - ÖRNEKLEM DIŞI (walk-forward): config.outOfSample aralığı — kurallar bu dönemi hiç görmeden
 *    seçildi. Coin karneleri, A+/A bantları ve sinyallerdeki karne buradan gelir. Dönem sabit olduğu
 *    için bir kez hesaplanır; strateji ayarları değişince yeniden hesaplanır.
 *  - ÖRNEKLEM İÇİ: son ~60 gün (6 saatte bir). Grafikteki geçmiş sinyaller buradan gelir.
 */
export class BacktestService {
  private data: Persisted;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly store: JsonStore<Persisted>;
  readonly version: string;

  constructor(
    private readonly market: MarketData,
    private readonly cfg: Config,
    dataDir: string,
  ) {
    this.version = createHash("md5")
      .update(JSON.stringify([LOGIC_VERSION, cfg.consensus, cfg.strategy, cfg.costs, cfg.outOfSample]))
      .digest("hex")
      .slice(0, 10);
    this.store = new JsonStore<Persisted>(dataDir, "backtest-v6.json");
    const saved = this.store.load({ version: "", updatedAt: null, oos: null, inSample: null, history: {} });
    this.data = saved.version === this.version ? saved : { version: this.version, updatedAt: null, oos: null, inSample: null, history: {} };
  }

  get options(): BacktestOptions {
    return {
      ...DEFAULT_BACKTEST_OPTIONS,
      expiryCandles: this.cfg.strategy.expiryCandles,
      cooldownCandles: this.cfg.strategy.cooldownCandles,
      breakevenAtR: this.cfg.strategy.breakevenAtR,
      roundTripFeePct: roundTripCostPct(this.cfg.costs),
    };
  }

  start(): void {
    const stale = !this.data.updatedAt || Date.now() - this.data.updatedAt > RERUN_MS || !this.data.oos;
    if (stale) setTimeout(() => void this.runAll(), 3000);
    this.timer = setInterval(() => void this.runAll(), RERUN_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Coinin örneklem dışı karnesi */
  record(symbol: string, interval: Interval = INTERVAL): TrackRecord | null {
    if (interval !== INTERVAL) return null;
    return this.data.oos?.results.find((r) => r.symbol === symbol) ?? null;
  }

  /** Bir coinin son ~60 gündeki AL sinyalleri (grafik için) */
  historyFor(symbol: string): HistorySignal[] {
    return this.data.history[symbol] ?? [];
  }

  /** Sinyal kalitesinin (A+ / A) örneklem dışı karnesi */
  estimate(_symbol: string, _interval: Interval, quality?: SignalQuality): WinEstimate {
    const band = quality ? this.data.oos?.bands.find((b) => b.label === quality) : null;
    return { record: band ?? null };
  }

  summary(): BacktestSummary {
    return {
      running: this.running,
      updatedAt: this.data.updatedAt,
      strategyVersion: this.version,
      outOfSample: this.data.oos?.report ?? null,
      inSample: this.data.inSample?.report ?? null,
      bands: this.data.oos?.bands ?? [],
      results: [...(this.data.oos?.results ?? [])].sort((a, b) => b.expectancyPct - a.expectancyPct),
    };
  }

  async runAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const started = Date.now();
    try {
      if (!this.data.oos) {
        this.data.oos = await this.runOutOfSample();
        this.persist();
      }
      const history: Record<string, HistorySignal[]> = {};
      this.data.inSample = await this.runInSample(history);
      this.data.history = history;
      this.data.updatedAt = Date.now();
      this.persist();
      const o = this.data.oos?.report;
      const s = this.data.inSample?.report;
      console.info(
        `[backtest] örneklem dışı: ${o?.trades ?? 0} işlem, kazanç %${o?.winRatePct.toFixed(1)}, net/işlem %${o?.expectancyPct.toFixed(3)} | ` +
          `son 60 gün: ${s?.trades ?? 0} işlem, kazanç %${s?.winRatePct.toFixed(1)} (${((Date.now() - started) / 1000).toFixed(0)}sn)`,
      );
    } catch (err) {
      console.error("[backtest]", (err as Error).message);
    } finally {
      this.running = false;
    }
  }

  private persist(): void {
    this.store.writeNow({ ...this.data, version: this.version });
  }

  private async runInSample(history: Record<string, HistorySignal[]>): Promise<PeriodData> {
    const btc4h = this.market.hasSymbol("BTCUSDT") ? await this.market.getClosedCandles("BTCUSDT", "4h", 1500) : undefined;
    const btc1d = this.market.hasSymbol("BTCUSDT") ? await this.market.getClosedCandles("BTCUSDT", "1d", 1000) : undefined;
    const perCoin: { symbol: string; data: ConsensusData; from?: number }[] = [];
    for (const symbol of this.market.symbols) {
      try {
        const data: ConsensusData = {
          h1: await this.market.getClosedCandles(symbol, "1h", 1500),
          m15: await this.market.getClosedCandles(symbol, "15m", 1500),
          h4: await this.market.getClosedCandles(symbol, "4h", 1500),
          d1: await this.market.getClosedCandles(symbol, "1d", 1000),
          btc4h,
          btc1d,
        };
        perCoin.push({ symbol, data });
        await new Promise((r) => setTimeout(r, 1500)); // istek limiti
      } catch (err) {
        console.error(`[backtest] ${symbol}:`, (err as Error).message);
      }
    }
    return this.evaluatePeriod(perCoin, history, btc1d);
  }

  private async runOutOfSample(): Promise<PeriodData> {
    const { from, to } = this.cfg.outOfSample;
    const warmup = 20 * DAY; // 400 saatlik pencere için ısınma
    console.info(`[backtest] örneklem dışı veri indiriliyor (${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)})…`);
    const btc4h = await fetchRange("BTCUSDT", "4h", from - 120 * DAY, to);
    const btc1d = await fetchRange("BTCUSDT", "1d", from - 420 * DAY, to);
    const perCoin: { symbol: string; data: ConsensusData; from?: number }[] = [];
    for (const symbol of this.market.symbols) {
      try {
        const h1 = await fetchRange(symbol, "1h", from - warmup, to);
        if (h1.length < 1000) continue; // bu dönemde işlem görmüyordu
        perCoin.push({
          symbol,
          from,
          data: {
            h1,
            m15: [], // 15dk verisi bu kadar geriye gitmiyor: 15dk oyu nötr kalır
            h4: await fetchRange(symbol, "4h", from - 120 * DAY, to),
            d1: await fetchRange(symbol, "1d", from - 420 * DAY, to),
            btc4h,
            btc1d,
          },
        });
        await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        console.error(`[backtest] örneklem dışı ${symbol}:`, (err as Error).message);
      }
    }
    return this.evaluatePeriod(perCoin, null, btc1d, from, to);
  }

  private async evaluatePeriod(
    perCoin: { symbol: string; data: ConsensusData; from?: number }[],
    history: Record<string, HistorySignal[]> | null,
    btc1d: Candle[] | undefined,
    periodFrom?: number,
    periodTo?: number,
  ): Promise<PeriodData> {
    const params = consensusParamsFrom(this.cfg);
    const opts = this.options;
    const all: SimTrade[] = [];
    const counter: MissedCounter = { missed: 0 };
    const results: BacktestResult[] = [];
    const holds: number[] = [];
    let pFrom = Infinity;
    let pTo = 0;
    for (const { symbol, data, from } of perCoin) {
      const hist: HistorySignal[] = [];
      counter.history = hist;
      counter.symbol = symbol;
      const trades = await backtestConsensusAsync(data, params, opts, { smartEntry: true, from }, counter);
      if (history) history[symbol] = hist;
      all.push(...trades);
      const s = stats(trades);
      const f = from ?? data.h1[210]?.openTime ?? 0;
      const t = data.h1[data.h1.length - 1]?.closeTime ?? 0;
      pFrom = Math.min(pFrom, f);
      pTo = Math.max(pTo, t);
      const bh = buyHoldPct(data.h1, f, t);
      if (bh != null) holds.push(bh);
      results.push({ ...s, symbol, interval: INTERVAL, from: f, to: t, updatedAt: Date.now() });
    }
    const from = periodFrom ?? pFrom;
    const to = periodTo ?? pTo;
    const bands: BacktestBand[] = [
      { label: "A+", missed: counter.missed, ...stats(all.filter((t) => t.confidence === 1)) },
      { label: "A", ...stats(all.filter((t) => t.confidence !== 1)) },
    ];
    // Önerilen kullanım (seçici mod) A+ sinyallerdir; toplam rapor A+ üzerinden
    const aPlus = all.filter((t) => t.confidence === 1);
    const eq = equityCurve(aPlus, 1);
    const report: PeriodReport | null = perCoin.length
      ? {
          ...stats(aPlus),
          from,
          to,
          coins: perCoin.length,
          maxDrawdownPct: eq.maxDrawdownPct,
          equityReturnPct: eq.returnPct,
          buyHoldPct: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0,
          btcBuyHoldPct: btc1d ? buyHoldPct(btc1d, from, to) : null,
        }
      : null;
    return { report, bands, results };
  }
}
