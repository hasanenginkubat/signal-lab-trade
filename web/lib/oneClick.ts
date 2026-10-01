"use client";

import type { OpenPositionRequest, PositionSide } from "@signal-lab/shared";
import { api } from "./api";
import { fmtUsd } from "./format";
import { getState, notify, refreshAccount } from "./store";

const TAKER_FEE = 0.0005;
const MMR = 0.005;

export interface SizeInput {
  entry: number;
  stopLoss: number;
  equity: number;
  available: number;
  riskPct: number;
  leverage: number;
}

/** Bu coinde Binance'in kabul ettiği en küçük emir (USDT); bilinmiyorsa 5 */
export function minOrderFor(symbol: string, price: number): number {
  const f = getState().minOrder[symbol];
  return f ? Math.max(f.minNotional, f.minQty * price) : 5;
}

export interface SizeResult {
  margin: number;
  leverage: number;
  notional: number;
  /** Stop olursa kaybedilecek tutar (ücretsiz) */
  riskUsdt: number;
  stopDistPct: number;
  /** Bakiye yetmediği için risk hedefin altında kaldı */
  capped: boolean;
  /** Likidasyon stoptan önce gelmesin diye kaldıraç düşürüldü */
  leverageReduced: boolean;
}

/**
 * Risk bazlı pozisyon büyüklüğü: stop olursa bakiyenin `riskPct`'i kadar kaybedilecek şekilde
 * hesaplanır. Kaldıraç, likidasyon fiyatı stop mesafesinin en az 1.5 katı uzakta kalacak kadar
 * düşürülür — böylece stop'tan önce likidasyon olmaz.
 */
export function sizePosition(i: SizeInput): SizeResult {
  const stopDist = Math.abs(i.entry - i.stopLoss) / i.entry;
  const maxLev = Math.max(1, Math.floor(1 / (stopDist * 1.5 + MMR)));
  const leverage = Math.min(i.leverage, maxLev);
  const targetRisk = (i.equity * i.riskPct) / 100;
  let notional = stopDist > 0 ? targetRisk / stopDist : 0;
  let margin = notional / leverage;
  const maxMargin = (i.available * 0.95) / (1 + leverage * TAKER_FEE);
  let capped = false;
  if (margin > maxMargin) {
    margin = Math.max(0, maxMargin);
    notional = margin * leverage;
    capped = true;
  }
  margin = Math.floor(margin * 100) / 100;
  notional = margin * leverage;
  return {
    margin,
    leverage,
    notional,
    riskUsdt: notional * stopDist,
    stopDistPct: stopDist * 100,
    capped,
    leverageReduced: leverage < i.leverage,
  };
}

export interface OneClickTarget {
  symbol: string;
  side: PositionSide;
  stopLoss: number;
  takeProfit: number;
  signalId?: string | null;
  /** Akıllı giriş limit seviyesi (yoksa sadece hemen al) */
  entryLimit?: number;
  entryValidUntil?: number;
}

export type EntryMode = "smart" | "market";

/** Akıllı giriş hâlâ geçerli mi (süre dolmadı ve seviye tanımlı) */
export function smartAvailable(t: OneClickTarget): boolean {
  return !!t.entryLimit && !!t.entryValidUntil && t.entryValidUntil > Date.now();
}

/** Güncel fiyat ve ayarlarla emir önizlemesi (henüz göndermeden). */
export function previewOneClick(t: OneClickTarget, mode: EntryMode = "market"): (SizeResult & { entry: number }) | null {
  const s = getState();
  const price = s.tickers[t.symbol]?.price;
  const summary = s.account?.summary;
  if (!price || !summary) return null;
  const long = t.side === "LONG";
  // Fiyat stopun ötesine ya da hedefe geçtiyse sinyal geçersiz
  if (long ? price <= t.stopLoss || price >= t.takeProfit : price >= t.stopLoss || price <= t.takeProfit) return null;
  // Akıllı girişte fiyat zaten limitin altındaysa güncel fiyattan dolar
  const entry = mode === "smart" && t.entryLimit ? (long ? Math.min(t.entryLimit, price) : Math.max(t.entryLimit, price)) : price;
  return {
    entry,
    ...sizePosition({
      entry,
      stopLoss: t.stopLoss,
      equity: summary.equity,
      available: summary.availableBalance,
      riskPct: s.settings.riskPct,
      leverage: s.settings.leverage,
    }),
  };
}

/**
 * Tek tıkla emir: risk bazlı büyüklük + SL + TP + oto başa baş.
 * "smart": sinyal fiyatının biraz altına limit emir (geri çekilmede alım), 6 saat geçerli,
 * fiyat dolmadan hedefe kaçarsa iptal. "market": hemen al.
 */
export async function executeOneClick(t: OneClickTarget, requested: EntryMode = "smart"): Promise<boolean> {
  const s = getState();
  const mode: EntryMode = requested === "smart" && smartAvailable(t) ? "smart" : "market";
  const preview = previewOneClick(t, mode);
  if (!preview) {
    notify("error", "Fiyat stop seviyesini geçmiş ya da hesap yüklenmedi — bu sinyal artık geçerli değil");
    return false;
  }
  const minOrder = minOrderFor(t.symbol, preview.entry);
  if (preview.notional < minOrder) {
    notify(
      "error",
      `${t.symbol}: Binance minimum emri ${minOrder.toFixed(2)} USDT, bu riskle pozisyon ${preview.notional.toFixed(2)} USDT. Bu coini atlayın (bakiye büyüdükçe açılır).`,
    );
    return false;
  }
  if (s.mode === "binance") {
    const ok = window.confirm(
      `GERÇEK EMİR: ${t.symbol} ${t.side} ${preview.leverage}x\n` +
        `Teminat ${fmtUsd(preview.margin)} USDT • Büyüklük ${fmtUsd(preview.notional)} USDT\n` +
        `Stop olursa kayıp ≈ ${fmtUsd(preview.riskUsdt)} USDT. Onaylıyor musunuz?`,
    );
    if (!ok) return false;
  }
  const smart = mode === "smart";
  const req: OpenPositionRequest = {
    symbol: t.symbol,
    side: t.side,
    type: smart ? "LIMIT" : "MARKET",
    limitPrice: smart ? t.entryLimit : undefined,
    expiresAt: smart ? t.entryValidUntil : null,
    cancelIfPriceReaches: smart ? t.takeProfit : null,
    margin: preview.margin,
    leverage: preview.leverage,
    stopLoss: t.stopLoss,
    takeProfit: t.takeProfit,
    signalId: t.signalId ?? null,
    breakevenAtR: 1,
    // Zaman stopu (varsayılan 48 saat — testte en kârlı ayar)
    maxHoldMs: (s.settings.maxHoldHours || 48) * 3_600_000,
  };
  try {
    // guarded: sunucu risk kalkanını uygular (pozisyon sınırı, günlük kayıp, mola, BTC rejimi)
    await api.openPosition(req, true);
    notify(
      "success",
      (smart
        ? `${t.symbol} akıllı giriş emri verildi: fiyat geri çekilince alınacak`
        : `${t.symbol} ${t.side === "LONG" ? "alındı" : "satıldı"}`) +
        ` • ${preview.leverage}x, risk ${fmtUsd(preview.riskUsdt)} USDT` +
        (preview.capped ? " (bakiye yetmediği için risk düşük kaldı)" : ""),
    );
    await refreshAccount();
    return true;
  } catch (err) {
    notify("error", (err as Error).message);
    return false;
  }
}
