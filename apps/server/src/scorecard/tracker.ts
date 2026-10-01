import { EventEmitter } from "node:events";
import {
  INTERVAL_MS,
  type Candle,
  type Scorecard,
  type ScorecardRow,
  type Signal,
  type SignalStatus,
} from "@signal-lab/shared";
import { BREAKEVEN_OFFSET_R } from "../backtest/backtest";
import { JsonStore } from "../db/jsonStore";

const MAX_SIGNALS = 3000;

export interface TrackerEvents {
  updated: [Signal];
}

export interface TrackerOptions {
  expiryCandles: number;
  /** Fiyat bu kadar R ilerleyince stop GİRİŞE taşınır; 0 = kapalı */
  breakevenAtR: number;
  /** Sonuçlardan düşülen gidiş-dönüş maliyet (%) — backtest ile aynı */
  roundTripCostPct: number;
}

/**
 * Sinyalleri saklar ve sonuçlarını BACKTEST İLE AYNI KURALLARLA takip eder (1dk mumlarla):
 *  - Akıllı girişli sinyal önce "bekliyor": fiyat limit seviyesine inerse dolar; dolmadan hedefe
 *    giderse ya da süre dolarsa MISSED.
 *  - Dolduktan sonra: aynı mumda stop ve hedef → STOP; 1R'de stop GİRİŞE taşınır (mum kapanınca);
 *    48 mumda sonuçlanmazsa EXPIRED.
 *  - Sonuç (resultPct) ücret + kayma düşülmüş nettir; başa baş çıkış bu yüzden hafif eksidir.
 */
export class SignalTracker extends EventEmitter<TrackerEvents> {
  private signals: Signal[];
  private readonly store: JsonStore<Signal[]>;
  private readonly opts: TrackerOptions;

  constructor(dataDir: string, expiryCandles: number, breakevenAtR = 0, roundTripCostPct = 0.14) {
    super();
    this.opts = { expiryCandles, breakevenAtR, roundTripCostPct };
    this.store = new JsonStore<Signal[]>(dataDir, "signals.json");
    this.signals = this.store.load([]);
  }

  add(signal: Signal): void {
    this.signals.push(signal);
    if (this.signals.length > MAX_SIGNALS) this.signals.splice(0, this.signals.length - MAX_SIGNALS);
    this.save();
  }

  get(id: string): Signal | undefined {
    return this.signals.find((s) => s.id === id);
  }

  list(filter: { symbol?: string; interval?: string; status?: string; limit?: number } = {}): Signal[] {
    let out = this.signals;
    if (filter.symbol) out = out.filter((s) => s.symbol === filter.symbol);
    if (filter.interval) out = out.filter((s) => s.interval === filter.interval);
    if (filter.status) out = out.filter((s) => s.status === filter.status);
    return out.slice(-(filter.limit ?? 200)).reverse();
  }

  latestFor(symbol: string, interval: string, side: Signal["side"]): Signal | undefined {
    for (let i = this.signals.length - 1; i >= 0; i--) {
      const s = this.signals[i];
      if (s.symbol === symbol && s.interval === interval && s.side === side) return s;
    }
    return undefined;
  }

  /**
   * Yeni sinyal engeli (backtest ile aynı): aynı coinde açık sinyal varsa ya da son sinyal
   * kapanalı `cooldownMs`'den az olduysa true.
   */
  positionBlock(symbol: string, now: number, cooldownMs: number): boolean {
    for (let i = this.signals.length - 1; i >= 0; i--) {
      const s = this.signals[i];
      if (s.symbol !== symbol || s.kind !== "consensus") continue;
      if (s.status === "OPEN") return true;
      if (s.closedAt && now - s.closedAt < cooldownMs) return true;
    }
    return false;
  }

  /** 1 dakikalık mum güncellemeleriyle çağrılır. */
  onCandle(candle: Candle): void {
    if (candle.interval !== "1m") return;
    let changed = false;
    for (const s of this.signals) {
      if (s.status !== "OPEN" || s.symbol !== candle.symbol) continue;
      // Sinyal mumu kapanmadan önce başlamış mumlar sinyal öncesi fiyatları içerir
      if (candle.openTime < s.createdAt - 1) continue;
      if (this.step(s, candle)) changed = true;
    }
    if (changed) this.save();
  }

  /** Tek sinyal için bir mumu işler; değişiklik olduysa true. */
  step(s: Signal, candle: Candle): boolean {
    const long = s.side === "LONG";
    const dir = long ? 1 : -1;

    // 1) Akıllı giriş bekleniyor
    if (s.entryLimit != null && s.fillPrice == null) {
      if (s.entryValidUntil && candle.openTime >= s.entryValidUntil) {
        this.close(s, "MISSED", candle.open, s.entryValidUntil);
        return true;
      }
      if (long ? candle.high >= s.takeProfit : candle.low <= s.takeProfit) {
        this.close(s, "MISSED", s.takeProfit, candle.closeTime);
        return true;
      }
      if (!(long ? candle.low <= s.entryLimit : candle.high >= s.entryLimit)) return false;
      s.fillPrice = s.entryLimit;
      s.filledAt = candle.openTime;
      if (long ? candle.low <= s.stopLoss : candle.high >= s.stopLoss) {
        this.close(s, "SL_HIT", s.stopLoss, candle.closeTime);
      } else {
        this.emit("updated", s);
      }
      return true; // çıkış kontrolleri bir sonraki mumdan itibaren (backtest ile aynı)
    }

    // 2) Pozisyon açık
    const entry = s.fillPrice ?? s.price;
    if (long ? candle.low <= s.stopLoss : candle.high >= s.stopLoss) {
      this.close(s, "SL_HIT", s.stopLoss, candle.closeTime);
      return true;
    }
    if (long ? candle.high >= s.takeProfit : candle.low <= s.takeProfit) {
      this.close(s, "TP_HIT", s.takeProfit, candle.closeTime);
      return true;
    }
    const startedAt = s.filledAt ?? s.createdAt;
    if (candle.isClosed && candle.closeTime >= startedAt + this.opts.expiryCandles * INTERVAL_MS[s.interval]) {
      this.close(s, "EXPIRED", candle.close, candle.closeTime);
      return true;
    }
    // Stop, mum KAPANDIKTAN sonra girişe taşınır (aynı mumda taşıyıp vurdurmak iyimser olurdu)
    if (this.opts.breakevenAtR > 0 && !s.stopMoved && candle.isClosed) {
      const initial = s.initialStopLoss ?? s.stopLoss;
      const risk = Math.abs(entry - initial);
      const reached = long ? candle.high >= entry + this.opts.breakevenAtR * risk : candle.low <= entry - this.opts.breakevenAtR * risk;
      if (reached) {
        s.initialStopLoss = initial;
        s.stopLoss = entry + dir * BREAKEVEN_OFFSET_R * risk;
        s.stopMoved = true;
        this.emit("updated", s);
        return true;
      }
    }
    return false;
  }

  scorecard(): Scorecard {
    const group = (keyOf: (s: Signal) => string) => {
      const map = new Map<string, Signal[]>();
      for (const s of this.signals) {
        const k = keyOf(s);
        const arr = map.get(k);
        if (arr) arr.push(s);
        else map.set(k, [s]);
      }
      return [...map.entries()].map(([k, arr]) => row(k, arr)).sort((a, b) => b.total - a.total);
    };
    return {
      overall: row("Tümü", this.signals),
      bySymbol: group((s) => s.symbol),
      byInterval: group((s) => s.interval),
      bySide: group((s) => s.side),
    };
  }

  flush(): void {
    this.store.flush(() => this.signals);
  }

  private close(s: Signal, status: SignalStatus, price: number, time: number): void {
    s.status = status;
    s.closePrice = price;
    s.closedAt = time;
    if (status === "MISSED") {
      s.resultPct = null;
    } else {
      const entry = s.fillPrice ?? s.price;
      const dir = s.side === "LONG" ? 1 : -1;
      s.resultPct = ((price - entry) / entry) * 100 * dir - this.opts.roundTripCostPct;
    }
    this.emit("updated", s);
  }

  private save(): void {
    this.store.scheduleSave(() => this.signals);
  }
}

/** Kazanç = hedef; başa baş (stop girişte) ve kayıp ayrı; kaçırılanlar orana katılmaz. */
function row(key: string, signals: Signal[]): ScorecardRow {
  const closed = signals.filter((s) => s.status !== "OPEN" && s.status !== "MISSED");
  const wins = closed.filter((s) => s.status === "TP_HIT").length;
  const breakevens = closed.filter((s) => s.status === "SL_HIT" && s.stopMoved).length;
  const losses = closed.filter((s) => s.status === "SL_HIT" && !s.stopMoved).length;
  const totalResultPct = closed.reduce((acc, s) => acc + (s.resultPct ?? 0), 0);
  return {
    key,
    total: signals.length,
    open: signals.filter((s) => s.status === "OPEN").length,
    wins,
    breakevens,
    losses,
    expired: closed.filter((s) => s.status === "EXPIRED").length,
    missed: signals.filter((s) => s.status === "MISSED").length,
    winRatePct: closed.length ? (wins / closed.length) * 100 : 0,
    avgResultPct: closed.length ? totalResultPct / closed.length : 0,
    totalResultPct,
  };
}
