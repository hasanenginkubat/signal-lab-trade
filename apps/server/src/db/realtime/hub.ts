import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  isInterval,
  type Candle,
  type ClientMessage,
  type Interval,
  type ServerMessage,
  type Ticker,
} from "@signal-lab/shared";

interface ClientState {
  symbol: string | null;
  interval: Interval | null;
  alive: boolean;
}

/**
 * Tarayıcı istemcilerine gerçek zamanlı yayın: fiyatlar (1sn'de bir toplu), abone olunan
 * sembol/aralığın mumları, sinyaller ve hesap durumu.
 */
export class RealtimeHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private pendingTickers = new Map<string, Ticker>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    server: Server,
    private readonly onConnect: (send: (msg: ServerMessage) => void) => void,
  ) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws) => this.handleConnection(ws));

    this.timers.push(
      setInterval(() => this.flushTickers(), 1000),
      setInterval(() => this.heartbeat(), 30_000),
    );
  }

  get clientCount(): number {
    return this.clients.size;
  }

  broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }

  queueTickers(tickers: Ticker[]): void {
    for (const t of tickers) this.pendingTickers.set(t.symbol, t);
  }

  sendCandle(candle: Candle): void {
    let payload: string | null = null;
    for (const [ws, state] of this.clients) {
      if (state.symbol !== candle.symbol || state.interval !== candle.interval) continue;
      if (ws.readyState !== WebSocket.OPEN) continue;
      payload ??= JSON.stringify({ type: "candle", data: candle } satisfies ServerMessage);
      ws.send(payload);
    }
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    for (const ws of this.clients.keys()) ws.terminate();
    this.wss.close();
  }

  private handleConnection(ws: WebSocket): void {
    const state: ClientState = { symbol: null, interval: null, alive: true };
    this.clients.set(ws, state);

    ws.on("pong", () => (state.alive = true));
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "subscribe" && typeof msg.symbol === "string" && isInterval(msg.interval)) {
        state.symbol = msg.symbol.toUpperCase();
        state.interval = msg.interval;
      } else if (msg.type === "unsubscribe") {
        state.symbol = null;
        state.interval = null;
      }
    });

    this.onConnect((msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
  }

  private flushTickers(): void {
    if (this.pendingTickers.size === 0) return;
    const data = [...this.pendingTickers.values()];
    this.pendingTickers = new Map();
    this.broadcast({ type: "tickers", data });
  }

  private heartbeat(): void {
    for (const [ws, state] of this.clients) {
      if (!state.alive) {
        ws.terminate();
        this.clients.delete(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }
}
