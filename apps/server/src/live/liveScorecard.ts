import {
  MIN_TRADES_FOR_STATS,
  type Candle,
  type LiveOutcome,
  type LivePoint,
  type LiveReport,
  type LiveSummary,
  type LiveTrade,
  type LiveWeek,
  type Signal,
  type SignalQuality,
} from "@signal-lab/shared";
import { JsonStore } from "../db/jsonStore";
import { weekStart } from "../signals/consensus";

const HOUR = 3_600_000;
const WEEK = 7 * 86_400_000;
const BTC = "BTCUSDT";

export interface LiveOptions {
  trackingStart: number;
  riskPct: number;
  /** Sayılan sinyal kalitesi (seçici mod) */
  quality: SignalQuality;
}

export interface LiveDeps {
  /** [from, to) aralığındaki kapanmış 1s mumlar */
  fetchCandles(symbol: string, from: number, to: number): Promise<Candle[]>;
  /** Belirli bir andaki fiyat (izleme başlangıcı için) */
  priceAt(symbol: string, time: number): Promise<number | null>;
  now?: () => number;
}

interface BasketItem {
  symbol: string;
  startPrice: number;
  /** Son bilinen kapanış (veri gelmezse taşınır) */
  last: number;
}

interface LiveState {
  version: 1;
  trackingStart: number;
  btcStart: number | null;
  basket: BasketItem[];
  btcLast: number | null;
  trades: LiveTrade[];
  points: LivePoint[];
  missed: string[];
  updatedAt: number | null;
}

const fresh = (trackingStart: number): LiveState => ({
  version: 1,
  trackingStart,
  btcStart: null,
  basket: [],
  btcLast: null,
  trades: [],
  points: [],
  missed: [],
  updatedAt: null,
});

// ---------- Saf hesaplar (birim testli) ----------

/** Al-tut değeri (başlangıç = 100) */
export const holdValue = (startPrice: number, price: number) => (100 * price) / startPrice;

/** Eşit ağırlıklı, yeniden dengelemesiz sepet: her coine başlangıçta eşit para → ortalama göreli fiyat */
export function basketValue(items: { startPrice: number; price: number }[]): number {
  if (!items.length) return 100;
  return items.reduce((a, x) => a + holdValue(x.startPrice, x.price), 0) / items.length;
}

/** Bakiye etkisi (%): risk = stop mesafesi; netPct / stopMesafesi = R; etki = riskPct × R */
export function balanceEffectPct(entry: number, stopLoss: number, netPct: number, riskPct: number): number {
  const stopDistPct = (Math.abs(entry - stopLoss) / entry) * 100;
  if (!(stopDistPct > 0)) return 0;
  return riskPct * (netPct / stopDistPct);
}

export function maxDrawdownPct(values: number[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, ((peak - v) / peak) * 100);
  }
  return dd;
}

export function outcomeOf(s: Signal): LiveOutcome | null {
  if (s.status === "TP_HIT") return "TP";
  if (s.status === "SL_HIT") return s.stopMoved ? "BE" : "SL";
  if (s.status === "EXPIRED") return "EXPIRED";
  return null;
}

/** Zamana göre bot bakiyesi: o ana kadar kapanmış işlemler (başlangıç 100) */
function botAt(trades: LiveTrade[], t: number): number {
  let v = 100;
  for (const tr of trades) if (tr.exitTime <= t) v = tr.balanceAfter;
  return v;
}

/** t anındaki (ya da öncesindeki son) nokta */
function pointAt(points: LivePoint[], t: number): LivePoint {
  let p = points[0];
  for (const x of points) {
    if (x.time > t) break;
    p = x;
  }
  return p;
}

const pct = (a: number, b: number) => (a ? (b / a - 1) * 100 : 0);

/** Rapor: eğri, haftalık tablo ve özet. trades exitTime'a göre sıralı olmalı. */
export function buildReport(state: LiveState, opts: LiveOptions, now: number, open: number): LiveReport {
  const start = state.trackingStart;
  const trades = [...state.trades].sort((a, b) => a.exitTime - b.exitTime);
  const points: LivePoint[] = [{ time: start, bot: 100, btc: 100, basket: 100 }, ...state.points.filter((p) => p.time > start)];
  // Eğriyi işlem kapanışlarında da güncelle (son nokta = şimdiki bot bakiyesi)
  const last = points[points.length - 1];
  const botNow = botAt(trades, now);
  if (last.bot !== botNow) points.push({ time: Math.max(now, last.time), bot: botNow, btc: last.btc, basket: last.basket });

  const weeks: LiveWeek[] = [];
  if (now > start) {
    for (let ws = weekStart(start); ws < now; ws += WEEK) {
      const from = Math.max(ws, start);
      const to = Math.min(ws + WEEK, now);
      const inWeek = trades.filter((t) => t.exitTime >= from && t.exitTime < to);
      const p0 = pointAt(points, from);
      const p1 = pointAt(points, to);
      const botPct = pct(botAt(trades, from - 1), botAt(trades, to - 1));
      const btcPct = pct(p0.btc, p1.btc);
      weeks.push({
        weekStart: ws,
        trades: inWeek.length,
        wins: inWeek.filter((t) => t.outcome === "TP").length,
        breakevens: inWeek.filter((t) => t.outcome === "BE").length,
        losses: inWeek.filter((t) => t.outcome === "SL").length,
        expired: inWeek.filter((t) => t.outcome === "EXPIRED").length,
        botPct,
        btcPct,
        basketPct: pct(p0.basket, p1.basket),
        diffPct: botPct - btcPct,
      });
    }
  }

  const n = trades.length;
  const gains = trades.filter((t) => t.netPct > 0).reduce((a, t) => a + t.netPct, 0);
  const lossSum = -trades.filter((t) => t.netPct <= 0).reduce((a, t) => a + t.netPct, 0);
  const days = Math.max(0, (now - start) / 86_400_000);
  const end = points[points.length - 1];
  const summary: LiveSummary = {
    trades: n,
    days,
    perDay: days > 0 ? n / Math.max(days, 1) : 0,
    wins: trades.filter((t) => t.outcome === "TP").length,
    breakevens: trades.filter((t) => t.outcome === "BE").length,
    losses: trades.filter((t) => t.outcome === "SL").length,
    expired: trades.filter((t) => t.outcome === "EXPIRED").length,
    winRatePct: n ? (trades.filter((t) => t.outcome === "TP").length / n) * 100 : 0,
    profitFactor: lossSum ? gains / lossSum : gains > 0 ? Infinity : 0,
    botReturnPct: botNow - 100,
    btcReturnPct: end.btc - 100,
    basketReturnPct: end.basket - 100,
    botMaxDdPct: maxDrawdownPct([100, ...trades.map((t) => t.balanceAfter)]),
    btcMaxDdPct: maxDrawdownPct(points.map((p) => p.btc)),
    basketMaxDdPct: maxDrawdownPct(points.map((p) => p.basket)),
    sufficient: n >= MIN_TRADES_FOR_STATS,
  };
  return {
    trackingStart: start,
    basket: state.basket.map((b) => b.symbol),
    quality: opts.quality,
    riskPct: opts.riskPct,
    updatedAt: state.updatedAt,
    open,
    missed: state.missed.length,
    points,
    weeks,
    summary,
    trades: [...trades].reverse(),
  };
}

// ---------- Kalıcı servis ----------

/**
 * Canlı izleme dönemi: seçili kalitedeki (A+) sinyallerin backtest ile aynı kurallarla takip edilen
 * sonuçlarını kâğıt işlem olarak kalıcı saklar; aynı başlangıçtan BTC ve sepet al-tut referanslarını
 * Binance 1s kapanışlarından hesaplar. Sunucu kapalıyken kaçan saatler açılışta tamamlanır.
 */
export class LiveScorecard {
  private state: LiveState;
  private readonly store: JsonStore<LiveState>;
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  /** Başlatma başarısız olursa / başlangıç henüz gelmediyse sync'te yeniden denenir */
  private symbols: string[] = [];

  constructor(
    dataDir: string,
    private readonly opts: LiveOptions,
    private readonly deps: LiveDeps,
  ) {
    this.store = new JsonStore<LiveState>(dataDir, "live-scorecard.json");
    const saved = this.store.load(fresh(opts.trackingStart));
    // Başlangıç değiştiyse karne sıfırdan (eski tarihten kalan hiçbir işlem girmez)
    this.state = saved.version === 1 && saved.trackingStart === opts.trackingStart ? saved : fresh(opts.trackingStart);
  }

  get trackingStart(): number {
    return this.state.trackingStart;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Sepeti başlangıçta sabitler (bir kez) ve başlangıç fiyatlarını alır. */
  async init(symbols: string[]): Promise<void> {
    this.symbols = symbols;
    if (this.now() < this.state.trackingStart) return;
    const t = this.state.trackingStart;
    if (this.state.btcStart == null) {
      const p = await this.deps.priceAt(BTC, t);
      if (p) this.state.btcStart = this.state.btcLast = p;
    }
    if (!this.state.basket.length) {
      const items: BasketItem[] = [];
      for (const symbol of symbols) {
        const p = await this.deps.priceAt(symbol, t).catch(() => null);
        if (p) items.push({ symbol, startPrice: p, last: p });
      }
      this.state.basket = items;
    }
    this.save();
  }

  /** Takipçinin sinyal güncellemesi; kapanmış ve sayılabilir ise kâğıt işlem olarak kaydeder. */
  onSignal(s: Signal): void {
    if (s.kind !== "consensus" || s.quality !== this.opts.quality) return;
    if (s.createdAt < this.state.trackingStart) return;
    if (s.status === "MISSED") {
      if (!this.state.missed.includes(s.id)) (this.state.missed.push(s.id), this.save());
      return;
    }
    const outcome = outcomeOf(s);
    if (!outcome || s.closePrice == null || s.closedAt == null || s.resultPct == null) return;
    if (this.state.trades.some((t) => t.id === s.id)) return;
    const entry = s.fillPrice ?? s.price;
    const stop = s.initialStopLoss ?? s.stopLoss;
    const effect = balanceEffectPct(entry, stop, s.resultPct, this.opts.riskPct);
    const prev = this.state.trades.filter((t) => t.exitTime <= s.closedAt!);
    const before = prev.length ? prev[prev.length - 1].balanceAfter : 100;
    this.state.trades.push({
      id: s.id,
      symbol: s.symbol,
      quality: s.quality ?? null,
      side: s.side,
      entryTime: s.filledAt ?? s.createdAt,
      entryPrice: entry,
      exitTime: s.closedAt,
      exitPrice: s.closePrice,
      stopLoss: stop,
      takeProfit: s.takeProfit,
      outcome,
      netPct: s.resultPct,
      balanceEffectPct: effect,
      balanceAfter: before * (1 + effect / 100),
    });
    this.recompute();
    this.save();
  }

  /** Bakiyeleri kapanış sırasına göre yeniden zincirler (geç gelen kayıtlar için) */
  private recompute(): void {
    this.state.trades.sort((a, b) => a.exitTime - b.exitTime);
    let v = 100;
    for (const t of this.state.trades) {
      v *= 1 + t.balanceEffectPct / 100;
      t.balanceAfter = v;
    }
    for (const p of this.state.points) p.bot = botAt(this.state.trades, p.time);
  }

  /** Son noktadan bu yana kapanmış saatler için BTC ve sepet değerlerini ekler. */
  sync(): Promise<void> {
    if (!this.syncing) this.syncing = this.doSync().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    if ((this.state.btcStart == null || !this.state.basket.length) && this.symbols.length) await this.init(this.symbols);
    const { btcStart, basket } = this.state;
    if (btcStart == null) return;
    const lastT = this.state.points.at(-1)?.time ?? this.state.trackingStart;
    const from = Math.floor(lastT / HOUR) * HOUR;
    const to = Math.floor(this.now() / HOUR) * HOUR;
    if (to <= from) return;
    const closes = async (symbol: string) => {
      const rows = await this.deps.fetchCandles(symbol, from, to).catch(() => [] as Candle[]);
      return new Map(rows.map((c) => [c.closeTime + 1, c.close]));
    };
    const btc = await closes(BTC);
    const per = new Map<string, Map<number, number>>();
    for (const b of basket) per.set(b.symbol, await closes(b.symbol));
    const times = [...btc.keys()].filter((t) => t > lastT).sort((a, b) => a - b);
    for (const t of times) {
      this.state.btcLast = btc.get(t)!;
      for (const b of basket) b.last = per.get(b.symbol)?.get(t) ?? b.last;
      this.state.points.push({
        time: t,
        bot: botAt(this.state.trades, t),
        btc: holdValue(btcStart, this.state.btcLast),
        basket: basketValue(basket.map((b) => ({ startPrice: b.startPrice, price: b.last }))),
      });
    }
    this.state.updatedAt = this.now();
    this.save();
  }

  /** Her saat başını 1 dk geçe eşitler. */
  start(): void {
    void this.sync().catch((e) => console.error("[live]", (e as Error).message));
    const schedule = () => {
      const wait = HOUR - (this.now() % HOUR) + 60_000;
      this.timer = setTimeout(() => {
        void this.sync().catch((e) => console.error("[live]", (e as Error).message)).finally(schedule);
      }, wait);
    };
    schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.flush();
  }

  report(open = 0): LiveReport {
    return buildReport(this.state, this.opts, this.now(), open);
  }

  flush(): void {
    this.store.writeNow(this.state);
  }

  private save(): void {
    this.store.scheduleSave(() => this.state);
  }
}
