import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Candle, Ticker } from "@signal-lab/shared";
import { miniTickerToTicker, toCandle } from "./mapper";
import type { BinanceCombinedMessage, BinanceKlineMessage, BinanceMiniTicker } from "./types";

/** Tek bağlantıdaki en fazla akış sayısı (Binance futures limiti 200). */
const STREAMS_PER_CONNECTION = 150;
/** Bu süre boyunca mesaj gelmezse bağlantı ölü sayılır. */
const STALE_MS = 30_000;

export type StreamStatus = "connected" | "connecting" | "disconnected";

export interface BinanceStreamEvents {
  candle: [Candle];
  tickers: [Ticker[]];
  status: [StreamStatus];
}

/**
 * Binance USDⓈ-M Futures birleşik akışlarını yönetir: akışları bağlantılara böler,
 * kopan bağlantıları üstel bekleme ile yeniden kurar ve sessiz kalan bağlantıları yeniler.
 */
export class BinanceStream extends EventEmitter<BinanceStreamEvents> {
  private connections: StreamConnection[] = [];
  private lastStatus: StreamStatus = "disconnected";

  constructor(
    private readonly wsBase: string,
    private readonly streams: string[],
  ) {
    super();
  }

  start(): void {
    for (let i = 0; i < this.streams.length; i += STREAMS_PER_CONNECTION) {
      const chunk = this.streams.slice(i, i + STREAMS_PER_CONNECTION);
      const conn = new StreamConnection(`${this.wsBase}/stream?streams=${chunk.join("/")}`, (msg) =>
        this.handle(msg),
      );
      conn.onStatus = () => this.emitStatus();
      this.connections.push(conn);
      conn.connect();
    }
  }

  stop(): void {
    for (const c of this.connections) c.close();
    this.connections = [];
  }

  get status(): StreamStatus {
    return this.lastStatus;
  }

  private emitStatus(): void {
    const statuses = this.connections.map((c) => c.status);
    const status: StreamStatus = statuses.every((s) => s === "connected")
      ? "connected"
      : statuses.some((s) => s === "connecting")
        ? "connecting"
        : "disconnected";
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.emit("status", status);
    }
  }

  private handle(msg: BinanceCombinedMessage): void {
    if (msg.stream === "!miniTicker@arr") {
      const tickers = (msg.data as BinanceMiniTicker[]).map(miniTickerToTicker);
      this.emit("tickers", tickers);
    } else if (msg.stream.includes("@kline_")) {
      this.emit("candle", toCandle(msg.data as BinanceKlineMessage));
    }
  }
}

class StreamConnection {
  status: StreamStatus = "disconnected";
  onStatus: () => void = () => {};
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUser = false;
  private lastMessageAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly onMessage: (msg: BinanceCombinedMessage) => void,
  ) {}

  connect(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      this.attempts = 0;
      this.lastMessageAt = Date.now();
      this.setStatus("connected");
      this.startWatchdog();
    });

    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      try {
        this.onMessage(JSON.parse(raw.toString()) as BinanceCombinedMessage);
      } catch (err) {
        console.error("[binance] mesaj işlenemedi:", (err as Error).message);
      }
    });

    ws.on("error", (err) => {
      console.error("[binance] websocket hatası:", err.message);
    });

    ws.on("close", () => {
      this.stopWatchdog();
      this.ws = null;
      this.setStatus("disconnected");
      if (!this.closedByUser) this.scheduleReconnect();
    });
  }

  close(): void {
    this.closedByUser = true;
    this.stopWatchdog();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(30_000, 1000 * 2 ** this.attempts++);
    console.warn(`[binance] bağlantı koptu, ${delay / 1000}sn sonra yeniden denenecek`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMessageAt > STALE_MS) {
        console.warn("[binance] akış sessiz kaldı, bağlantı yenileniyor");
        this.ws?.terminate();
      }
    }, 10_000);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private setStatus(status: StreamStatus): void {
    this.status = status;
    this.onStatus();
  }
}
