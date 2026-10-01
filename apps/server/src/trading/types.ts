import type { EventEmitter } from "node:events";
import type {
  AccountMode,
  AccountState,
  EquityPoint,
  OpenPositionRequest,
  PendingOrder,
  Position,
  Trade,
  UpdateProtectionRequest,
} from "@signal-lab/shared";

export interface BrokerEvents {
  /** Hesap durumu değişti (fiyat, pozisyon, emir…). Yayın tarafı kısıtlar (throttle). */
  changed: [];
  trade: [Trade];
  notice: [{ level: "info" | "warn" | "error"; message: string }];
}

export interface Broker extends EventEmitter<BrokerEvents> {
  readonly mode: AccountMode;
  start(): Promise<void>;
  stop(): void;
  getState(): Promise<AccountState>;
  openPosition(req: OpenPositionRequest): Promise<Position | PendingOrder>;
  /** percent: 1-100 arası; kısmi kapatma destekler */
  closePosition(id: string, percent?: number): Promise<Trade | null>;
  updateProtection(id: string, req: UpdateProtectionRequest): Promise<Position>;
  cancelOrder(id: string): Promise<void>;
  getTrades(limit?: number): Promise<Trade[]>;
  getEquityHistory(): Promise<EquityPoint[]>;
  /** Sadece kâğıt hesapta: bakiyeyi sıfırlar */
  reset?(initialBalance?: number): Promise<void>;
}

/** Kullanıcıya gösterilebilir iş kuralı hatası (HTTP 400). */
export class TradingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "TradingError";
  }
}
