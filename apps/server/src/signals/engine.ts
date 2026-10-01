import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  consensusLabel,
  findLevels,
  INTERVAL_MS,
  type Candle,
  type ConsensusView,
  type Interval,
  type Signal,
  type SymbolBias,
} from "@signal-lab/shared";
import { writeSignalNote } from "../analysis/writer";
import { HIGHER_TIMEFRAME, SMART_ENTRY_ATR, SMART_ENTRY_CANDLES } from "../backtest/backtest";
import type { BacktestService } from "../backtest/service";
import type { Config } from "../config";
import type { MarketData } from "../market/marketData";
import type { SignalTracker } from "../scorecard/tracker";
import { consensusParamsFrom, evaluateConsensus, type ConsensusParams, type ConsensusResult } from "./consensus";
import { evaluate } from "./strategy";

export interface EngineEvents {
  signal: [Signal];
  bias: [SymbolBias];
  consensus: [ConsensusView];
  exitAlert: [{ symbol: string; score: number; message: string }];
}

/** Konsensüs sinyallerinin üretildiği (ve backtest edildiği) aralık */
export const CONSENSUS_INTERVAL: Interval = "1h";

/**
 * Sinyal motoru — TEK karar kaynağı.
 * Her 1s kapanışında (ve açılışta) her coin için konsensüs + sinyal kapısı bir kez hesaplanır;
 * aynı sonuç hem görünümü (liste, orta/sağ panel, analiz) hem sinyali hem bildirimi besler.
 * Ara yenileme yok: etiket ile sinyal her zaman aynı veriden gelir.
 */
export class SignalEngine extends EventEmitter<EngineEvents> {
  private readonly biases = new Map<string, SymbolBias>();
  private readonly views = new Map<string, ConsensusView>();
  private readonly evaluated = new Set<string>();

  constructor(
    private readonly market: MarketData,
    private readonly tracker: SignalTracker,
    private readonly cfg: Config,
    private readonly backtests: BacktestService,
  ) {
    super();
  }

  /** Bias için öncelikli aralık: 1h varsa o, yoksa ilk sinyal aralığı. */
  get primaryInterval(): Interval {
    return this.cfg.signalIntervals.includes("1h") ? "1h" : this.cfg.signalIntervals[0];
  }

  get consensusParams(): ConsensusParams {
    return consensusParamsFrom(this.cfg);
  }

  async start(): Promise<void> {
    this.market.on("candleClosed", (c) => {
      const iv = c.interval as Interval;
      const run = async () => {
        if (this.cfg.signalIntervals.includes(iv)) await this.onBiasClose(c);
        if (iv === CONSENSUS_INTERVAL) {
          // 1s kapanışı 4s/1G kapanışıyla aynı ana denk gelebilir; o akışların da işlenmesi için kısa bekle
          await new Promise((r) => setTimeout(r, 3000));
          await this.processClose(c.symbol, c.openTime);
        }
      };
      void run().catch((err) => console.error("[engine]", (err as Error).message));
    });

    // Isınma: eğilimler + her coinin son kapanmış mumu için kapı (geçiyorsa sinyal de oluşur)
    const jobs: (() => Promise<void>)[] = [];
    for (const symbol of this.market.symbols) {
      for (const interval of this.cfg.signalIntervals) {
        jobs.push(async () => {
          const candles = await this.market.getClosedCandles(symbol, interval, this.cfg.historyLimit);
          this.updateBias(symbol, interval, candles, await this.higherCandles(symbol, interval));
        });
      }
      jobs.push(() => this.processClose(symbol, null));
    }
    await runLimited(jobs, 5);
    console.info(`[engine] ${this.market.symbols.length} coin için ısınma tamamlandı`);
  }

  getBiases(): SymbolBias[] {
    const iv = this.primaryInterval;
    return this.market.symbols.map((s) => this.biases.get(`${s}:${iv}`)).filter((b): b is SymbolBias => !!b);
  }

  getBias(symbol: string, interval: Interval = this.primaryInterval): SymbolBias | undefined {
    return this.biases.get(`${symbol}:${interval}`);
  }

  getView(symbol: string): ConsensusView | undefined {
    return this.views.get(symbol);
  }

  getViews(): ConsensusView[] {
    return [...this.views.values()];
  }

  /** Trend onayı için üst zaman diliminin kapanmış mumları */
  async higherCandles(symbol: string, interval: Interval): Promise<Candle[] | undefined> {
    const htf = HIGHER_TIMEFRAME[interval];
    if (!htf) return undefined;
    try {
      return await this.market.getClosedCandles(symbol, htf, 300);
    } catch {
      return undefined;
    }
  }

  /** Konsensüs + kapıyı hesaplar (görünümü değiştirmez). */
  async computeConsensus(symbol: string): Promise<{ result: ConsensusResult; h1: Candle[] }> {
    const [h1, m15, h4, d1, btc4h, btc1d] = await Promise.all([
      this.market.getClosedCandles(symbol, "1h", 400),
      this.market.getClosedCandles(symbol, "15m", 200),
      this.market.getClosedCandles(symbol, "4h", 300),
      this.market.getClosedCandles(symbol, "1d", 400),
      this.market.hasSymbol("BTCUSDT") ? this.market.getClosedCandles("BTCUSDT", "4h", 300) : Promise.resolve(undefined),
      this.market.hasSymbol("BTCUSDT") ? this.market.getClosedCandles("BTCUSDT", "1d", 300) : Promise.resolve(undefined),
    ]);
    return { result: evaluateConsensus({ h1, m15, h4, d1, btc4h, btc1d }, this.consensusParams), h1 };
  }

  /** Kapı sonucundan görünüm — tüm arayüz bileşenleri bunu okur */
  toView(symbol: string, result: ConsensusResult, candleTime: number | null): ConsensusView {
    const p = this.consensusParams;
    const sig = result.signal;
    return {
      symbol,
      score: result.score,
      label: consensusLabel(result.score, p.threshold, sig ? { passed: true, quality: sig.quality, side: sig.side } : null, p.allowShort),
      agree: result.agree,
      total: result.total,
      items: result.votes,
      levels: result.levels,
      blockedBy: result.gate.blockedBy,
      quality: sig?.quality ?? null,
      btcTrend: result.btcTrend,
      btcDailyTrend: result.btcDailyTrend,
      passed: result.gate.passed,
      checks: result.gate.checks,
      plan: sig?.plan ?? null,
      confidence: result.confidence,
      adx: result.adx,
      rsi: result.rsi,
      atr: result.atr,
      candleTime,
      updatedAt: Date.now(),
    };
  }

  /**
   * Bir 1s kapanışını işler: görünümü günceller, kapı geçtiyse (ve aynı coinde açık sinyal yoksa,
   * cooldown dolduysa) sinyal oluşturur. `openTime` null ise son kapanmış mum (açılış/ısınma).
   */
  async processClose(symbol: string, openTime: number | null): Promise<void> {
    const prevScore = this.views.get(symbol)?.score ?? 0;
    const { result, h1 } = await this.computeConsensus(symbol);
    const last = h1[h1.length - 1];
    if (!last) return;
    if (openTime !== null && last.openTime !== openTime) return; // önbellek henüz güncel değil
    const key = `${symbol}:${last.openTime}`;
    const view = this.toView(symbol, result, last.openTime);
    this.views.set(symbol, view);
    this.emit("consensus", view);
    if (this.evaluated.has(key)) return;
    this.evaluated.add(key);
    if (this.evaluated.size > 10_000) this.evaluated.clear();

    // UZAK DUR uyarısı (yalnızca canlı kapanışlarda): short değil, koruma amaçlı
    const exitAt = this.cfg.consensus.exitAlert;
    if (openTime !== null && result.score <= exitAt && prevScore > exitAt) {
      this.emit("exitAlert", {
        symbol,
        score: result.score,
        message: `UZAK DUR: ${symbol} — koşulların büyük çoğunluğu aşağıyı gösteriyor (konsensüs %${result.score}). Yeni alım yapmayın; long pozisyonunuz varsa stop'unuzu kontrol edin.`,
      });
    }

    const sig = result.signal;
    if (!sig) return;
    // Açılışta yalnızca henüz taze (son 1 saat) kapanış için sinyal üret
    if (openTime === null && Date.now() - (last.closeTime + 1) > INTERVAL_MS[CONSENSUS_INTERVAL]) return;
    if (this.tracker.list({ symbol, limit: 50 }).some((s) => s.candleTime === last.openTime && s.kind === "consensus")) return;
    // Aynı coinde açık sinyal varken yeni sinyal yok; cooldown kapanıştan sayılır (backtest ile aynı)
    const cooldownMs = this.cfg.strategy.cooldownCandles * INTERVAL_MS[CONSENSUS_INTERVAL];
    if (this.tracker.positionBlock(symbol, last.closeTime + 1, cooldownMs)) return;

    const p = this.consensusParams;
    const label = consensusLabel(result.score, p.threshold, { passed: true, quality: sig.quality, side: sig.side }, p.allowShort);
    const dir = sig.side === "LONG" ? 1 : -1;
    const estimate = this.backtests.estimate(symbol, CONSENSUS_INTERVAL, sig.quality);
    const signal: Signal = {
      id: randomUUID(),
      symbol,
      interval: CONSENSUS_INTERVAL,
      side: sig.side,
      price: sig.plan.entry,
      candleTime: last.openTime,
      createdAt: last.closeTime + 1,
      strength: Math.abs(result.score),
      score: result.score,
      reasons: result.votes.filter((v) => v.vote === dir).map((v) => v.detail),
      stopLoss: sig.stopLoss,
      takeProfit: sig.takeProfit,
      status: "OPEN",
      closedAt: null,
      closePrice: null,
      resultPct: null,
      initialStopLoss: sig.stopLoss,
      stopMoved: false,
      riskReward: sig.riskReward,
      kind: "consensus",
      label,
      quality: sig.quality,
      qualityNotes: sig.qualityNotes,
      entryLimit: sig.plan.entry - dir * SMART_ENTRY_ATR * sig.atr,
      entryValidUntil: last.closeTime + 1 + SMART_ENTRY_CANDLES * INTERVAL_MS[CONSENSUS_INTERVAL],
      consensus: result.score,
      checklist: result.votes,
      // Kalite seviyesinin örneklem dışı kazanç oranı (yalnızca n ≥ 30 ise)
      confidence: estimate.record?.sufficient ? Math.round(estimate.record.winRatePct) : undefined,
      history: estimate.record ?? null,
    };
    const levels = findLevels(h1, sig.atr * 0.6, 3, 300);
    const support = levels.filter((l) => l.price < signal.price).sort((x, y) => y.price - x.price)[0]?.price ?? null;
    signal.note = writeSignalNote(signal, view, {
      resistance: sig.plan.resistance,
      support,
      adx: result.adx,
      bands: this.backtests.summary().bands,
    });

    this.tracker.add(signal);
    console.info(
      `[engine] ${label} (${sig.quality}) ${symbol} @ ${signal.price} konsensüs=%${result.score} (${result.agree}/${result.total}) R:R ${sig.riskReward.toFixed(2)}`,
    );
    this.emit("signal", signal);
  }

  private async onBiasClose(candle: Candle): Promise<void> {
    const interval = candle.interval as Interval;
    const candles = await this.market.getClosedCandles(candle.symbol, interval, this.cfg.historyLimit);
    if (candles[candles.length - 1]?.openTime !== candle.openTime) return;
    this.updateBias(candle.symbol, interval, candles, await this.higherCandles(candle.symbol, interval));
  }

  private updateBias(symbol: string, interval: Interval, candles: Candle[], higher?: Candle[]) {
    const result = evaluate(candles, this.cfg.strategy, higher);
    const bias: SymbolBias = {
      symbol,
      interval,
      trend: result.trend,
      rsi: result.rsi,
      score: result.score,
      updatedAt: Date.now(),
    };
    this.biases.set(`${symbol}:${interval}`, bias);
    this.emit("bias", bias);
    return result;
  }
}

async function runLimited(jobs: (() => Promise<void>)[], concurrency: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        await job();
      } catch (err) {
        console.error("[engine] ısınma hatası:", (err as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
