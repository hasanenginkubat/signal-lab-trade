import { EventEmitter } from "node:events";
import { INTERVALS, type Candle, type Interval, type Ticker } from "@signal-lab/shared";
import { fetchKlines, fetchTickers } from "../binance/rest";
import { BinanceStream, type StreamStatus } from "../binance/stream";

const MAX_CANDLES = 1500;

export interface MarketDataEvents {
  candle: [Candle];
  candleClosed: [Candle];
  tickers: [Ticker[]];
  price: [string, number];
  status: [StreamStatus];
}

/**
 * Tüm semboller × aralıklar için canlı mum akışını dinler, REST ile yüklenmiş geçmişi
 * canlı veriyle birleştirip hafızada tutar ve son fiyatları yayınlar.
 */
export class MarketData extends EventEmitter<MarketDataEvents> {
  private readonly stores = new Map<string, Candle[]>();
  private readonly loading = new Map<string, Promise<Candle[]>>();
  private readonly tickers = new Map<string, Ticker>();
  private readonly stream: BinanceStream;
  private wasDisconnected = false;

  constructor(
    readonly symbols: string[],
    wsBase: string,
  ) {
    super();
    this.setMaxListeners(50);
    const streams = ["!miniTicker@arr"];
    for (const s of symbols) for (const iv of INTERVALS) streams.push(`${s.toLowerCase()}@kline_${iv}`);
    this.stream = new BinanceStream(wsBase, streams);
    this.stream.on("candle", (c) => this.onCandle(c));
    this.stream.on("tickers", (t) => this.onTickers(t));
    this.stream.on("status", (status) => this.onStatus(status));
  }

  async start(): Promise<void> {
    try {
      for (const t of await fetchTickers(this.symbols)) this.tickers.set(t.symbol, t);
    } catch (err) {
      console.error("[market] ilk fiyatlar alınamadı:", (err as Error).message);
    }
    this.stream.start();
  }

  stop(): void {
    this.stream.stop();
  }

  get status(): StreamStatus {
    return this.stream.status;
  }

  hasSymbol(symbol: string): boolean {
    return this.symbols.includes(symbol);
  }

  getTickers(): Ticker[] {
    return this.symbols.map((s) => this.tickers.get(s)).filter((t): t is Ticker => Boolean(t));
  }

  getPrice(symbol: string): number | null {
    return this.tickers.get(symbol)?.price ?? null;
  }

  /** Son `limit` mumu döner; hafızada yoksa REST'ten yükler. */
  async getCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
    const key = `${symbol}:${interval}`;
    const store = this.stores.get(key);
    if (store && store.length >= Math.min(limit, MAX_CANDLES)) return store.slice(-limit);

    let pending = this.loading.get(key);
    if (!pending) {
      pending = fetchKlines(symbol, interval, Math.max(limit, 500))
        .then((candles) => {
          // Yükleme sırasında akıştan gelen mumlarla birleştir
          const live = this.stores.get(key) ?? [];
          const merged = mergeCandles(candles, live);
          this.stores.set(key, merged);
          return merged;
        })
        .finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    const candles = await pending;
    return candles.slice(-limit);
  }

  /** Sadece kapanmış mumlar (sinyal motoru için). */
  async getClosedCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
    const candles = await this.getCandles(symbol, interval, limit + 1);
    return candles.filter((c) => c.isClosed).slice(-limit);
  }

  private onCandle(candle: Candle): void {
    const key = `${candle.symbol}:${candle.interval}`;
    const store = this.stores.get(key);
    if (store) {
      upsert(store, candle);
    } else if (this.loading.has(key)) {
      // Yükleme bitince birleştirilmek üzere geçici olarak sakla
      this.stores.set(key, [candle]);
    }
    this.emit("candle", candle);
    if (candle.isClosed) this.emit("candleClosed", candle);
  }

  private onTickers(tickers: Ticker[]): void {
    const changed: Ticker[] = [];
    for (const t of tickers) {
      if (!this.hasSymbol(t.symbol)) continue;
      this.tickers.set(t.symbol, t);
      changed.push(t);
      this.emit("price", t.symbol, t.price);
    }
    if (changed.length) this.emit("tickers", changed);
  }

  private onStatus(status: StreamStatus): void {
    if (status === "disconnected") this.wasDisconnected = true;
    if (status === "connected" && this.wasDisconnected) {
      // Kopukluk süresinde kaçan mumlar olabilir; önbelleği sıfırla, istek gelince tazelenir.
      this.wasDisconnected = false;
      this.stores.clear();
      console.info("[market] yeniden bağlanıldı, mum önbelleği temizlendi");
    }
    this.emit("status", status);
  }
}

function upsert(store: Candle[], candle: Candle): void {
  const last = store[store.length - 1];
  if (!last || candle.openTime > last.openTime) {
    store.push(candle);
    if (store.length > MAX_CANDLES) store.splice(0, store.length - MAX_CANDLES);
  } else if (candle.openTime === last.openTime) {
    store[store.length - 1] = candle;
  } else {
    const idx = store.findIndex((c) => c.openTime === candle.openTime);
    if (idx >= 0) store[idx] = candle;
  }
}

function mergeCandles(history: Candle[], live: Candle[]): Candle[] {
  const merged = [...history];
  for (const c of live) upsert(merged, c);
  return merged;
}
