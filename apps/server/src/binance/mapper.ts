import type { Candle, Ticker } from "@signal-lab/shared";
import type {
  BinanceKlineMessage,
  BinanceKlineRow,
  BinanceMiniTicker,
  BinanceTicker24h,
} from "./types";

export function toCandle(rawMsg: BinanceKlineMessage): Candle {
  const kline = rawMsg.k;

  return {
    symbol: kline.s,
    interval: kline.i,
    openTime: kline.t,
    closeTime: kline.T,
    open: Number(kline.o),
    high: Number(kline.h),
    low: Number(kline.l),
    close: Number(kline.c),
    volume: Number(kline.v),
    isClosed: kline.x,
  };
}

export function rowToCandle(symbol: string, interval: string, row: BinanceKlineRow, now = Date.now()): Candle {
  return {
    symbol,
    interval,
    openTime: row[0],
    closeTime: row[6],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    isClosed: row[6] < now,
  };
}

export function miniTickerToTicker(t: BinanceMiniTicker): Ticker {
  const price = Number(t.c);
  const open = Number(t.o);
  return {
    symbol: t.s,
    price,
    open,
    high: Number(t.h),
    low: Number(t.l),
    changePct: open ? ((price - open) / open) * 100 : 0,
    quoteVolume: Number(t.q),
    updatedAt: t.E,
  };
}

export function ticker24hToTicker(t: BinanceTicker24h): Ticker {
  return {
    symbol: t.symbol,
    price: Number(t.lastPrice),
    open: Number(t.openPrice),
    high: Number(t.highPrice),
    low: Number(t.lowPrice),
    changePct: Number(t.priceChangePercent),
    quoteVolume: Number(t.quoteVolume),
    updatedAt: t.closeTime,
  };
}
