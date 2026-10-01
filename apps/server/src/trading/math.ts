import { MAX_LEVERAGE, MIN_NOTIONAL_USDT, type OpenPositionRequest, type PositionSide } from "@signal-lab/shared";
import { TradingError } from "./types";

export function direction(side: PositionSide): 1 | -1 {
  return side === "LONG" ? 1 : -1;
}

export function pnl(side: PositionSide, entry: number, exit: number, quantity: number): number {
  return (exit - entry) * quantity * direction(side);
}

/**
 * Isolated marjin için yaklaşık likidasyon fiyatı: teminat − bakım marjı kadar zarar
 * oluştuğunda pozisyon likide olur.
 *   LONG : entry × (1 − 1/lev + mmr)
 *   SHORT: entry × (1 + 1/lev − mmr)
 */
export function liquidationPrice(side: PositionSide, entry: number, leverage: number, mmr: number): number {
  const price = side === "LONG" ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
  return Math.max(0, price);
}

export function validateOpenRequest(req: OpenPositionRequest, referencePrice: number, maxLeverage = MAX_LEVERAGE): void {
  if (req.side !== "LONG" && req.side !== "SHORT") throw new TradingError("Yön LONG ya da SHORT olmalı");
  if (req.type !== "MARKET" && req.type !== "LIMIT") throw new TradingError("Emir tipi MARKET ya da LIMIT olmalı");
  if (!(req.margin > 0)) throw new TradingError("Teminat sıfırdan büyük olmalı");
  if (!Number.isInteger(req.leverage) || req.leverage < 1 || req.leverage > maxLeverage) {
    throw new TradingError(`Kaldıraç 1-${maxLeverage} arasında tam sayı olmalı`);
  }
  if (req.type === "LIMIT" && !(req.limitPrice && req.limitPrice > 0)) {
    throw new TradingError("Limit emir için geçerli bir fiyat girin");
  }
  if (req.margin * req.leverage < MIN_NOTIONAL_USDT) {
    throw new TradingError(`Pozisyon büyüklüğü en az ${MIN_NOTIONAL_USDT} USDT olmalı`);
  }
  validateProtection(req.side, referencePrice, req.stopLoss ?? null, req.takeProfit ?? null);
}

export function validateProtection(
  side: PositionSide,
  price: number,
  stopLoss: number | null,
  takeProfit: number | null,
): void {
  const long = side === "LONG";
  if (stopLoss != null) {
    if (!(stopLoss > 0)) throw new TradingError("Stop loss fiyatı geçersiz");
    if (long ? stopLoss >= price : stopLoss <= price) {
      throw new TradingError(`Stop loss ${long ? "giriş fiyatının altında" : "giriş fiyatının üstünde"} olmalı`);
    }
  }
  if (takeProfit != null) {
    if (!(takeProfit > 0)) throw new TradingError("Take profit fiyatı geçersiz");
    if (long ? takeProfit <= price : takeProfit >= price) {
      throw new TradingError(`Take profit ${long ? "giriş fiyatının üstünde" : "giriş fiyatının altında"} olmalı`);
    }
  }
}

export function startOfDay(ts = Date.now()): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
