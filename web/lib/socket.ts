"use client";

import type { ClientMessage, Interval, ServerMessage } from "@signal-lab/shared";
import { WS_URL } from "./api";

type Listener = (msg: ServerMessage) => void;
export type SocketState = "connecting" | "open" | "closed";

/**
 * Tarayıcı tarafında tek bir WebSocket bağlantısı: otomatik yeniden bağlanır ve
 * yeniden bağlandığında son aboneliği tekrar gönderir.
 */
class SocketClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(s: SocketState) => void>();
  private subscription: { symbol: string; interval: Interval } | null = null;
  private attempts = 0;
  private started = false;
  state: SocketState = "closed";

  start(): void {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.connect();
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (s: SocketState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  subscribe(symbol: string, interval: Interval): void {
    this.subscription = { symbol, interval };
    this.send({ type: "subscribe", symbol, interval });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setState(s: SocketState): void {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }

  private connect(): void {
    this.setState("connecting");
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.setState("open");
      if (this.subscription) this.send({ type: "subscribe", ...this.subscription });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.setState("closed");
      const delay = Math.min(15_000, 500 * 2 ** this.attempts++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }
}

export const socket = new SocketClient();
